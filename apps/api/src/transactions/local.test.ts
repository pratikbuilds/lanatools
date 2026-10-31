import { afterAll, beforeAll, expect, test } from 'bun:test'
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
import type { PreparedTransaction } from '@lanatools/contracts'
import { createApp } from '../app'
import { mcpGrant } from '../db/schema'
import { createTransactionLinks } from '../routes/transaction-links'
import type { TransactionLinksEnv } from '../routes/transaction-links'
import { PAYMENT_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import {
  createTransactionRequest,
  sendTransaction,
  transactionStatus,
} from './requests'
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
    // These builders never read accounts.
    accounts: {} as TransactionRpc['accounts'],
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

async function connect() {
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
  return identity
}

async function signed(candidate: PreparedTransaction) {
  const unsigned = getTransactionDecoder().decode(
    getBase64Encoder().encode(candidate.transaction),
  )
  return getBase64EncodedWireTransaction(
    await signTransaction([wallet.keyPair], unsigned),
  )
}

test('local delivery returns unsigned bytes for the wallet and sends what that wallet signed', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const input = {
    ...args,
    delivery: 'local',
    wallet: wallet.address,
    idempotencyKey: crypto.randomUUID(),
  }
  const created = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    input,
    { rpc: fake.rpc },
  )
  if (!created.ok) throw new Error(created.error.message)
  expect(TransactionResult.allows(created.result)).toBe(true)
  expect(created.result).toMatchObject({
    delivery: 'local',
    status: 'ready',
    signature: null,
    transaction: { account: wallet.address, network: 'devnet' },
  })
  expect(created.result).not.toHaveProperty('reviewUrl')
  const candidate = created.result.transaction
  if (!candidate) throw new Error('Missing transaction')

  // A retry and a status read return the same unsigned bytes.
  expect(
    await createTransactionRequest(env(), identity, 'solana_transfer', input, {
      rpc: fake.rpc,
    }),
  ).toMatchObject({ ok: true, result: { transaction: candidate } })
  expect(
    await transactionStatus(env(), identity, created.result.id, {
      rpc: fake.rpc,
    }),
  ).toMatchObject({ ok: true, result: { transaction: candidate } })

  const wire = await signed(candidate)
  const sent = await sendTransaction(
    env(),
    identity,
    created.result.id,
    { transaction: wire },
    { rpc: fake.rpc, observation },
  )
  if (!sent.ok) throw new Error(sent.error.message)
  expect(fake.sent).toEqual([wire])
  expect(sent.result).toMatchObject({
    delivery: 'local',
    status: 'confirmed',
    receipt: { slot: '123', commitment: 'confirmed' },
  })
  expect(sent.result.signature).toBe(sent.result.receipt?.signature ?? '')
  expect(sent.result).not.toHaveProperty('transaction')
  expect(sent.result).not.toHaveProperty('accountUrl')

  // Once sent, a retry reports status instead of new bytes.
  expect(
    await createTransactionRequest(env(), identity, 'solana_transfer', input, {
      rpc: fake.rpc,
    }),
  ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
})

test('local delivery needs a wallet, keeps it, and accepts only a signed transaction', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const input = {
    ...args,
    delivery: 'local',
    idempotencyKey: crypto.randomUUID(),
  }
  expect(
    await createTransactionRequest(env(), identity, 'solana_transfer', input, {
      rpc: fake.rpc,
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(
    await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      { ...input, delivery: 'link', wallet: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })

  const created = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    { ...input, wallet: wallet.address },
    { rpc: fake.rpc },
  )
  if (!created.ok || !created.result.transaction)
    throw new Error('Not prepared')
  const other = await generateKeyPairSigner()
  expect(
    await createTransactionRequest(
      env(),
      identity,
      'solana_transfer',
      { ...input, wallet: other.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(
    await sendTransaction(
      env(),
      identity,
      created.result.id,
      // Unsigned bytes carry no valid signature from the wallet.
      { transaction: created.result.transaction.transaction },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(fake.sent).toHaveLength(0)
})

test('send_transaction is only for the creator and only for local requests', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const local = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    {
      ...args,
      delivery: 'local',
      wallet: wallet.address,
      idempotencyKey: crypto.randomUUID(),
    },
    { rpc: fake.rpc },
  )
  const link = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    { ...args, delivery: 'link', idempotencyKey: crypto.randomUUID() },
  )
  if (!local.ok || !local.result.transaction || !link.ok)
    throw new Error('Not created')
  const wire = await signed(local.result.transaction)
  const stranger = await connect()
  expect(
    await sendTransaction(
      env(),
      stranger,
      local.result.id,
      { transaction: wire },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(
    await sendTransaction(
      env(),
      identity,
      link.result.id,
      { transaction: wire },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(fake.sent).toHaveLength(0)
})

test('the public link routes do not expose local requests', async () => {
  const identity = await connect()
  const fake = mockRpc()
  const local = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    {
      ...args,
      delivery: 'local',
      wallet: wallet.address,
      idempotencyKey: crypto.randomUUID(),
    },
    { rpc: fake.rpc },
  )
  if (!local.ok) throw new Error(local.error.message)
  const app = createApp<TransactionLinksEnv>().route(
    '/api/transaction-links',
    createTransactionLinks({ rpc: fake.rpc }),
  )
  const bindings = {
    ...env(),
    TRANSACTION_LINK_LIMITER: { limit: async () => ({ success: true }) },
  }
  const base = `/api/transaction-links/${local.result.id}`
  expect((await app.request(base, {}, bindings)).status).toBe(404)
  for (const [suffix, body] of [
    ['transaction', { account: wallet.address }],
    ['send', { transaction: 'AA==' }],
  ] as const)
    expect(
      (
        await app.request(
          `${base}/${suffix}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          bindings,
        )
      ).status,
    ).toBe(404)
  expect(fake.sent).toHaveLength(0)
})
