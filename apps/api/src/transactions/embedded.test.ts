import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
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
import { mcpGrant, paymentSigner, transactionRequest } from '../db/schema'
import { PolicyDeniedError } from '../payments/privy-signer'
import { disableSigner } from '../payments/signer-setup'
import { PAYMENT_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import type { EmbeddedSigner } from './embedded'
import {
  createTransactionRequest,
  requestDelivery,
  transactionStatus,
} from './requests'
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

test.each(['review', 'build', 'sign'] as const)(
  'removing wallet access during %s prevents embedded relay',
  async (stage) => {
    const identity = await connect()
    const fake = mockRpc()
    const local = localSigner()
    const sign = mock<EmbeddedSigner>(async (embeddedWallet, transaction) => {
      if (stage === 'sign') await disableSigner(db, identity.userId)
      return local(embeddedWallet, transaction)
    })
    const request = input()
    const created = await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      request,
      {
        rpc: fake.rpc,
        observation,
        embeddedSigner: sign,
        tools: {
          solana_transfer: {
            ...solTransfer,
            review: async (intent, context) => {
              const review = await solTransfer.review(intent, context)
              if (stage === 'review') await disableSigner(db, identity.userId)
              return review
            },
            build: async (intent, account, context) => {
              const candidate = await solTransfer.build(
                intent,
                account,
                context,
              )
              if (stage === 'build') await disableSigner(db, identity.userId)
              return candidate
            },
          },
        },
      },
    )
    expect(created.ok).toBe(false)
    expect(sign).toHaveBeenCalledTimes(stage === 'sign' ? 1 : 0)
    expect(fake.sent).toHaveLength(0)
    const row = await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.idempotencyKey, request.idempotencyKey))
      .get()
    if (stage === 'review') expect(row).toBeUndefined()
    else expect(row?.signature).toBeNull()
  },
)

test('embedded retries restore the same signed bytes after a transient relay failure', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const sign = localSigner()
  const request = input()
  let landed = false
  fake.rpc.send = async (wire) => {
    fake.sent.push(wire)
    if (fake.sent.length === 1)
      throw new Error('connection refused before broadcast')
    landed = true
    return ''
  }
  fake.rpc.status = async () =>
    landed ? { err: null, slot: 123n, confirmationStatus: 'confirmed' } : null
  const options = { rpc: fake.rpc, observation, embeddedSigner: sign }
  const first = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    request,
    options,
  )
  expect(first).toMatchObject({ ok: true, result: { status: 'unknown' } })
  if (!first.ok) throw new Error(first.error.message)
  const retry = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    request,
    options,
  )
  expect(retry).toMatchObject({
    ok: true,
    result: { status: 'confirmed', signature: first.result.signature },
  })
  expect(fake.sent).toHaveLength(2)
  expect(fake.sent[1]).toBe(fake.sent[0])
  expect(sign).toHaveBeenCalledTimes(1)

  await disableSigner(db, identity.userId)
  expect(
    await transactionStatus(env(), identity, first.result.id, options),
  ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
})

test('a failed embedded build retains its wallet and can be retried', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const sign = localSigner()
  const request = input()
  const latest = fake.rpc.latestBlockhash
  fake.rpc.latestBlockhash = async () => {
    throw new Error('RPC temporarily unavailable')
  }
  const options = { rpc: fake.rpc, observation, embeddedSigner: sign }
  expect(
    await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      request,
      options,
    ),
  ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(sign).not.toHaveBeenCalled()
  fake.rpc.latestBlockhash = latest
  expect(
    await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      request,
      options,
    ),
  ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
  expect(sign).toHaveBeenCalledTimes(1)
})

test.each(['removed access', 'expired blockhash'] as const)(
  'an embedded retry does not relay after %s',
  async (reason) => {
    const identity = await connect()
    const fake = mockRpc()
    const sign = localSigner()
    const request = input()
    fake.rpc.status = async () => null
    fake.rpc.send = async (wire) => {
      fake.sent.push(wire)
      throw new Error('connection refused before broadcast')
    }
    const options = { rpc: fake.rpc, observation, embeddedSigner: sign }
    const first = await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      request,
      options,
    )
    expect(first).toMatchObject({ ok: true, result: { status: 'unknown' } })
    if (reason === 'removed access') await disableSigner(db, identity.userId)
    else fake.rpc.blockHeight = async () => 501n
    const retry = await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      request,
      options,
    )
    expect(retry).toMatchObject(
      reason === 'removed access'
        ? { ok: false, error: { code: 'embedded_unavailable' } }
        : { ok: true, result: { status: 'unknown' } },
    )
    expect(fake.sent).toHaveLength(1)
    expect(sign).toHaveBeenCalledTimes(1)
  },
)

test('the cleanup migration removes unsupported requests and keeps current tools', async () => {
  const identity = await connect()
  const ids = ['jupiter_build_swap', 'solana_transfer', 'jupiter_swap'].map(
    () => crypto.randomUUID(),
  )
  await drizzle(db)
    .insert(transactionRequest)
    .values(
      ['jupiter_build_swap', 'solana_transfer', 'jupiter_swap'].map(
        (toolName, index) => ({
          id: ids[index]!,
          toolName,
          argumentsJson: '{}',
          network: 'devnet' as const,
          creatorUserId: identity.userId,
          creatorClientId: identity.clientId,
          creatorGrantId: identity.grantId,
          idempotencyKey: ids[index]!,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + 900000,
        }),
      ),
    )
  await db
    .prepare(
      await Bun.file(
        new URL(
          '../../drizzle/0016_remove_unsupported_transactions.sql',
          import.meta.url,
        ),
      ).text(),
    )
    .run()
  for (const [index, id] of ids.entries()) {
    const row = await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.id, id))
      .get()
    if (index === 0) expect(row).toBeUndefined()
    else expect(row).toBeDefined()
  }
})
