import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { D1Database, RateLimit } from '@cloudflare/workers-types'
import { TransactionLink } from '@lanatools/contracts'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { blockhash } from '@solana/kit'
import { createApp } from '../app'
import { mcpGrant, transactionRequest } from '../db/schema'
import { testDatabase } from '../test-database'
import { PAYMENT_NETWORKS } from '../solana/network'
import { createTransactionRequest } from '../transactions/requests'
import { createTransactionLinks, transactionLinks } from './transaction-links'
import type { TransactionLinksEnv } from './transaction-links'

let db: D1Database
let limiter: RateLimit
let dispose: () => Promise<void>
let linkId: string
const app = createApp<TransactionLinksEnv>().route(
  '/api/transaction-links',
  transactionLinks,
)
beforeAll(async () => {
  const database = await testDatabase()
  db = database.db
  limiter = database.transactionLinkLimiter
  dispose = database.dispose
  const identity = { userId: 'creator', clientId: 'client', grantId: 'grant' }
  await drizzle(db).insert(mcpGrant).values({
    scope: 'account:read jupiter:read solana:transfer',
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    createdAt: Date.now(),
  })
  const created = await createTransactionRequest(
    { DB: db, SOLANA_NETWORK: 'devnet', WEB_ORIGIN: 'http://localhost:5173' },
    identity,
    'solana_transfer',
    {
      recipient: '11111111111111111111111111111111',
      amountLamports: '10000000',
      delivery: 'link',
      idempotencyKey: 'route-test',
    },
  )
  if (!created.ok) throw new Error(created.error.message)
  linkId = created.result.id
}, 60_000)
afterAll(() => dispose())
const get = (id: string, rateLimit = limiter) =>
  app.request(
    `/api/transaction-links/${id}`,
    {},
    {
      DB: db,
      TRANSACTION_LINK_LIMITER: rateLimit,
      SOLANA_NETWORK: 'devnet',
      SOLANA_RPC_URL: 'https://invalid.example',
      WEB_ORIGIN: 'http://localhost:5173',
    },
  )

test('signed-out GET returns public review with no cache and no execution writes', async () => {
  const before = await db
    .prepare('select * from transaction_request where id = ?')
    .bind(linkId)
    .first()
  const response = await get(linkId)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(TransactionLink.assert(await response.json())).toMatchObject({
    id: linkId,
    status: 'open',
    account: null,
    signature: null,
  })
  expect<unknown>(
    await db
      .prepare('select * from transaction_request where id = ?')
      .bind(linkId)
      .first(),
  ).toEqual(before)
})

test('missing link is 404 and unsupported approve endpoint does not exist', async () => {
  expect((await get('missing')).status).toBe(404)
  for (const suffix of ['approve'])
    expect(
      (
        await app.request(
          `/api/transaction-links/${linkId}/${suffix}`,
          { method: 'POST' },
          {
            DB: db,
            TRANSACTION_LINK_LIMITER: limiter,
            SOLANA_NETWORK: 'devnet',
            SOLANA_RPC_URL: 'https://invalid.example',
            WEB_ORIGIN: 'http://localhost:5173',
          },
        )
      ).status,
    ).toBe(404)
})

test('public requests are rate limited before reading links', async () => {
  const response = await get(linkId, {
    limit: async () => ({ success: false }),
  })
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
})

test('database failure returns a safe retriable error', async () => {
  await db
    .prepare('alter table transaction_request rename to unavailable_links')
    .run()
  try {
    const response = await get(linkId)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: 'Internal server error',
    })
  } finally {
    await db
      .prepare('alter table unavailable_links rename to transaction_request')
      .run()
  }
})

test('prepare and send reject malformed input and caller network overrides', async () => {
  for (const [suffix, body] of [
    [
      'transaction',
      { account: '11111111111111111111111111111111', network: 'mainnet' },
    ],
    ['send', { transaction: 'AAAA', network: 'mainnet' }],
    ['transaction', {}],
    ['send', { signature: 'claimed' }],
  ] as const) {
    const response = await app.request(
      `/api/transaction-links/${linkId}/${suffix}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      {
        DB: db,
        TRANSACTION_LINK_LIMITER: limiter,
        SOLANA_NETWORK: 'devnet',
        SOLANA_RPC_URL: 'https://invalid.example',
        WEB_ORIGIN: 'http://localhost:5173',
      },
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_input', retryable: false },
    })
  }
})

test('public GET recovers chain confirmation from a saved signature without building or sending', async () => {
  const env = {
    DB: db,
    TRANSACTION_LINK_LIMITER: limiter,
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: 'https://unused.example',
    WEB_ORIGIN: 'http://localhost:5173',
  }
  const created = await createTransactionRequest(
    env,
    { userId: 'creator', clientId: 'client', grantId: 'grant' },
    'solana_transfer',
    {
      recipient: '11111111111111111111111111111111',
      amountLamports: '10',
      delivery: 'link',
      idempotencyKey: crypto.randomUUID(),
    },
  )
  if (!created.ok) throw new Error(created.error.message)
  const id = created.result.id
  const signature = '5'.repeat(88)
  await drizzle(db)
    .update(transactionRequest)
    .set({ status: 'submitting', signature })
    .where(eq(transactionRequest.id, id))
  const calls: string[] = []
  const recoveringApp = createApp<TransactionLinksEnv>().route(
    '/api/transaction-links',
    createTransactionLinks({
      rpc: {
        genesisHash: async () => PAYMENT_NETWORKS.devnet.genesisHash,
        latestBlockhash: async () => {
          calls.push('build')
          return {
            blockhash: blockhash(PAYMENT_NETWORKS.devnet.genesisHash),
            lastValidBlockHeight: 500n,
          }
        },
        blockHeight: async () => 100n,
        send: async () => {
          calls.push('send')
          return signature
        },
        status: async (value) => {
          calls.push('status')
          expect(value).toBe(signature)
          return { err: null, slot: 456n, confirmationStatus: 'confirmed' }
        },
      },
    }),
  )
  const response = await recoveringApp.request(
    `/api/transaction-links/${id}`,
    {},
    env,
  )
  expect(response.status).toBe(200)
  expect(TransactionLink.assert(await response.json())).toMatchObject({
    status: 'confirmed',
    signature,
    receipt: { signature, slot: '456' },
  })
  expect(calls).toEqual(['status'])
  expect(
    await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.id, id))
      .get(),
  ).toMatchObject({ status: 'confirmed', signature })
})
