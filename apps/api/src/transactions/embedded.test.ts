import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import {
  address,
  blockhash,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  signTransaction,
} from '@solana/kit'
import type { KeyPairSigner } from '@solana/kit'
import { TransactionResult } from '@lanatools/contracts'
import { mcpGrant, paymentSigner } from '../db/schema'
import { PolicyDeniedError } from '../payments/privy-signer'
import { PAYMENT_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import type { EmbeddedSigner } from './embedded'
import { createTransactionRequest, requestDelivery } from './requests'
import { solTransfer } from './sol-transfer'
import type { TransactionRpc } from './submission'

let db: D1Database
let dispose: () => Promise<void>
let wallet: KeyPairSigner
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
  wallet = await generateKeyPairSigner()
}, 60_000)
afterAll(() => dispose())

const env = () => ({
  DB: db,
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://unused.example',
  WEB_ORIGIN: 'http://localhost:5173',
})
const args = {
  recipient: address('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N'),
  amountLamports: '10000001',
}
const observation = { attempts: 1, intervalMs: 0 }

function mockRpc() {
  const sent: string[] = []
  const rpc: TransactionRpc = {
    genesisHash: async () => PAYMENT_NETWORKS.devnet.genesisHash,
    latestBlockhash: async () => ({
      blockhash: blockhash(PAYMENT_NETWORKS.devnet.genesisHash),
      lastValidBlockHeight: 500n,
    }),
    blockHeight: async () => 100n,
    send: async (wire) => {
      sent.push(wire)
      return ''
    },
    status: async () => ({
      err: null,
      slot: 123n,
      confirmationStatus: 'confirmed',
    }),
  }
  return { rpc, sent }
}

/** Signs as Privy would for the user's wallet, with a local key. */
function localSigner() {
  return mock<EmbeddedSigner>(async (_wallet, transaction) =>
    getBase64EncodedWireTransaction(
      await signTransaction(
        [wallet.keyPair],
        getTransactionDecoder().decode(getBase64Encoder().encode(transaction)),
      ),
    ),
  )
}

async function connect(
  signer: Partial<typeof paymentSigner.$inferInsert> | null = {},
) {
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    scope: 'account:read solana:transfer',
    createdAt: Date.now(),
  })
  if (signer)
    await drizzle(db)
      .insert(paymentSigner)
      .values({
        privyUserId: identity.userId,
        walletId: 'privy-wallet-1',
        walletAddress: wallet.address,
        policyId: 'policy-1',
        transactionPolicyId: 'tx-policy-1',
        status: 'enabled',
        updatedAt: Date.now(),
        ...signer,
      })
  return identity
}

const input = () => ({
  ...args,
  delivery: 'embedded',
  idempotencyKey: crypto.randomUUID(),
})

test('embedded delivery signs with the LanaTools wallet and sends at once', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const sign = localSigner()
  const request = input()
  const created = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    request,
    { rpc: fake.rpc, observation, embeddedSigner: sign },
  )
  if (!created.ok) throw new Error(created.error.message)
  expect(TransactionResult.allows(created.result)).toBe(true)
  expect(created.result).toMatchObject({
    delivery: 'embedded',
    status: 'confirmed',
    receipt: { slot: '123' },
  })
  expect(created.result).not.toHaveProperty('reviewUrl')
  expect(created.result).not.toHaveProperty('transaction')
  expect(sign).toHaveBeenCalledTimes(1)
  expect(sign.mock.calls[0]?.[0]).toEqual({
    walletId: 'privy-wallet-1',
    walletAddress: wallet.address,
  })
  expect(fake.sent).toHaveLength(1)
  expect(await requestDelivery(db, created.result.id)).toBe('embedded')

  // A retry reports the result; it never signs or sends again.
  expect(
    await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      request,
      {
        rpc: fake.rpc,
        observation,
        embeddedSigner: sign,
      },
    ),
  ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
  expect(sign).toHaveBeenCalledTimes(1)
  expect(fake.sent).toHaveLength(1)
})

test('embedded delivery is off without a set-up, enabled transaction signer', async () => {
  for (const signer of [
    null,
    { status: 'disabled' as const },
    { status: 'pending' as const },
    { transactionPolicyId: null },
  ]) {
    const identity = await connect(signer)
    const fake = mockRpc()
    const sign = localSigner()
    expect(
      await createTransactionRequest(
        env(),
        identity,
        'solana_transfer',
        input(),
        { rpc: fake.rpc, embeddedSigner: sign },
      ),
    ).toMatchObject({ ok: false, error: { code: 'embedded_unavailable' } })
    expect(sign).not.toHaveBeenCalled()
  }
  const identity = await connect()
  expect(
    await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      input(),
      { rpc: mockRpc().rpc, embeddedSigner: null },
    ),
  ).toMatchObject({ ok: false, error: { code: 'embedded_unavailable' } })
  expect(
    await createTransactionRequest(env(), identity, 'solana_transfer', {
      ...input(),
      wallet: wallet.address,
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})

test('a policy refusal sends nothing and says the policy refused', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const refused = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    input(),
    {
      rpc: fake.rpc,
      embeddedSigner: async () => {
        throw new PolicyDeniedError('denied')
      },
    },
  )
  expect(refused).toMatchObject({
    ok: false,
    error: { code: 'signing_refused', retryable: false },
  })
  expect(fake.sent).toHaveLength(0)
})

test('bytes that are not the prepared transaction are refused before sending', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const other = await generateKeyPairSigner()
  const foreign = await solTransfer.build(args, other.address, {
    requestId: 'other-request',
    network: 'devnet',
    rpc: fake.rpc,
  })
  const result = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    input(),
    {
      rpc: fake.rpc,
      embeddedSigner: async () =>
        getBase64EncodedWireTransaction(
          await signTransaction(
            [other.keyPair],
            getTransactionDecoder().decode(
              getBase64Encoder().encode(foreign.transaction),
            ),
          ),
        ),
    },
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(fake.sent).toHaveLength(0)
})
