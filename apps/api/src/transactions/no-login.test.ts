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
import type { PreparedTransaction } from '@lanatools/contracts'
import { createApp } from '../app'
import { eq } from 'drizzle-orm'
import { mcpGrant, transactionRequest } from '../db/schema'
import { createTransactionLinks } from '../routes/transaction-links'
import type { TransactionLinksEnv } from '../routes/transaction-links'
import { PAYMENT_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import {
  NO_LOGIN,
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

const localInput = (idempotencyKey = crypto.randomUUID()) => ({
  ...args,
  delivery: 'local',
  wallet: wallet.address,
  idempotencyKey,
})

test('without login, a local request is built, signed by the wallet and sent', async () => {
  const fake = mockRpc()
  const input = localInput()
  const created = await createTransactionRequest(
    env(),
    null,
    'solana_transfer',
    input,
    { rpc: fake.rpc },
  )
  if (!created.ok) throw new Error(created.error.message)
  expect(created.result).toMatchObject({ delivery: 'local', status: 'ready' })
  const candidate = created.result.transaction
  if (!candidate) throw new Error('Missing transaction')
  const row = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, created.result.id))
    .get()
  expect(row).toMatchObject({
    creatorUserId: NO_LOGIN,
    creatorGrantId: NO_LOGIN,
    creatorClientId: `wallet:${wallet.address}`,
  })

  // The key is scoped to the wallet, so a retry returns the same request.
  expect(
    await createTransactionRequest(env(), null, 'solana_transfer', input, {
      rpc: fake.rpc,
    }),
  ).toMatchObject({ ok: true, result: { id: created.result.id } })
  expect(
    await transactionStatus(env(), null, created.result.id, { rpc: fake.rpc }),
  ).toMatchObject({ ok: true, result: { transaction: candidate } })

  const wire = await signed(candidate)
  const sent = await sendTransaction(
    env(),
    null,
    created.result.id,
    { transaction: wire },
    { rpc: fake.rpc, observation },
  )
  if (!sent.ok) throw new Error(sent.error.message)
  expect(fake.sent).toEqual([wire])
  expect(sent.result.status).toBe('confirmed')
})

test('without login, the LanaTools wallet cannot sign', async () => {
  const outcome = await createTransactionRequest(
    env(),
    null,
    'solana_transfer',
    { ...args, delivery: 'embedded', idempotencyKey: crypto.randomUUID() },
    { rpc: mockRpc().rpc },
  )
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: 'login_required' },
  })
})

test('without login, a link opens on the public review page and keys are not reused', async () => {
  const fake = mockRpc()
  const input = {
    ...args,
    delivery: 'link',
    idempotencyKey: 'same-key',
  }
  const first = await createTransactionRequest(
    env(),
    null,
    'solana_transfer',
    input,
    { rpc: fake.rpc },
  )
  const second = await createTransactionRequest(
    env(),
    null,
    'solana_transfer',
    input,
    { rpc: fake.rpc },
  )
  if (!first.ok || !second.ok) throw new Error('Link was not created')
  expect(first.result).toMatchObject({ delivery: 'link', status: 'open' })
  expect(first.result.reviewUrl).toBe(
    `http://localhost:5173/tx/${first.result.id}`,
  )
  expect(second.result.id).not.toBe(first.result.id)

  const app = createApp<TransactionLinksEnv>().route(
    '/api/transaction-links',
    createTransactionLinks({ rpc: fake.rpc }),
  )
  const bindings = {
    ...env(),
    TRANSACTION_LINK_LIMITER: { limit: async () => ({ success: true }) },
  }
  const page = await app.request(
    `/api/transaction-links/${first.result.id}`,
    {},
    bindings,
  )
  expect(page.status).toBe(200)
  expect(await page.json()).toMatchObject({ status: 'open' })
  const prepared = await app.request(
    `/api/transaction-links/${first.result.id}/transaction`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: wallet.address }),
    },
    bindings,
  )
  expect(prepared.status).toBe(200)
})

test('requests without login and logged-in requests cannot read each other', async () => {
  const fake = mockRpc()
  const identity = await connect()
  const mine = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    localInput(),
    { rpc: fake.rpc },
  )
  const anonymous = await createTransactionRequest(
    env(),
    null,
    'solana_transfer',
    localInput(),
    { rpc: fake.rpc },
  )
  if (!mine.ok || !anonymous.ok) throw new Error('Request was not created')
  for (const [caller, id] of [
    [null, mine.result.id],
    [identity, anonymous.result.id],
  ] as const) {
    expect(
      await transactionStatus(env(), caller, id, { rpc: fake.rpc }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } })
    expect(
      await sendTransaction(
        env(),
        caller,
        id,
        { transaction: 'AA==' },
        { rpc: fake.rpc },
      ),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  }
  expect(fake.sent).toHaveLength(0)
})
