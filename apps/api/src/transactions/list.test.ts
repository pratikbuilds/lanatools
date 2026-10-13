import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { TransactionsPage } from '@lanatools/contracts'
import type { PerpTrade } from '@lanatools/contracts'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import { mcpGrant, transactionRequest, walletTransfer } from '../db/schema'
import { testDatabase } from '../test-database'
import {
  listTransactions,
  parseTransactionsCursor,
  readTransaction,
} from './list'
import type { TransactionsFilter } from './list'
import type { TransactionRpc } from './submission'

const NOON = Date.UTC(2026, 9, 10, 12)
const MINUTE = 60_000
const RECIPIENT = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const WALLET = 'G7fu2vBDEZ9SYM4agJPshffJQUmyg6UCEEUnxuYRAMuq'
const OTHER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const SIGNATURE = '5'.repeat(87)

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

let user: string
beforeEach(() => {
  user = `user-${crypto.randomUUID()}`
})

const env = () => ({
  DB: db,
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://unused.example',
  WEB_ORIGIN: 'http://localhost:5173',
})

async function connect(
  clientId: string,
  {
    clientName = 'Codex',
    status = 'active',
    grantId = crypto.randomUUID(),
  }: {
    clientName?: string
    status?: 'active' | 'revoked'
    grantId?: string
  } = {},
) {
  await drizzle(db).insert(mcpGrant).values({
    id: grantId,
    privyUserId: user,
    clientId,
    clientName,
    status,
    scope: 'account:read jupiter:read solana:transfer',
    createdAt: NOON,
  })
  return grantId
}

async function request(
  grantId: string,
  values: Partial<typeof transactionRequest.$inferInsert> = {},
) {
  const id = values.id ?? crypto.randomUUID()
  await drizzle(db)
    .insert(transactionRequest)
    .values({
      toolName: 'solana_transfer',
      argumentsJson: JSON.stringify({
        recipient: RECIPIENT,
        amountLamports: '10000000',
      }),
      network: 'devnet',
      creatorUserId: user,
      creatorClientId: 'client-a',
      creatorGrantId: grantId,
      idempotencyKey: id,
      delivery: 'link',
      status: 'open',
      counterparty: RECIPIENT,
      createdAt: NOON,
      updatedAt: NOON,
      expiresAt: NOON + 15 * MINUTE,
      ...values,
      id,
    })
  return id
}

async function transfer(
  values: Partial<typeof walletTransfer.$inferInsert> = {},
) {
  const id = values.id ?? crypto.randomUUID()
  await drizzle(db)
    .insert(walletTransfer)
    .values({
      privyUserId: user,
      wallet: WALLET,
      direction: 'in',
      network: 'devnet',
      mint: 'native',
      symbol: 'SOL',
      decimals: 9,
      amountAtomic: '100000000',
      counterparty: OTHER,
      signature: crypto.randomUUID(),
      status: 'confirmed',
      source: 'chain_sync',
      createdAt: NOON,
      updatedAt: NOON,
      ...values,
      id,
    })
  return id
}

function list(filter: Partial<TransactionsFilter> = {}, now = NOON) {
  return listTransactions(env(), user, { limit: 50, ...filter }, { now })
}

test('agent requests and wallet transfers are one feed, newest first', async () => {
  const grant = await connect('client-a')
  const older = await request(grant, { createdAt: NOON - 2 * MINUTE })
  const deposit = await transfer({ createdAt: NOON - MINUTE })
  const newest = await request(grant, {
    status: 'confirmed',
    signature: SIGNATURE,
    account: WALLET,
    receiptJson: JSON.stringify({
      signature: SIGNATURE,
      slot: '1',
      commitment: 'finalized',
    }),
  })
  const page = await list()
  expect(TransactionsPage.allows(page)).toBe(true)
  expect(page.items.map((item) => item.id)).toEqual([newest, deposit, older])
  expect(page.items[0]).toMatchObject({
    kind: 'agent',
    tool: 'solana_transfer',
    delivery: 'link',
    status: 'confirmed',
    clientId: 'client-a',
    clientName: 'Codex',
    connected: true,
    account: WALLET,
    counterparty: RECIPIENT,
    signature: SIGNATURE,
    receipt: { slot: '1', commitment: 'finalized' },
    reviewUrl: null,
  })
  expect(page.items[1]).toMatchObject({
    kind: 'deposit',
    status: 'confirmed',
    mint: 'native',
    symbol: 'SOL',
    amountAtomic: '100000000',
    counterparty: OTHER,
  })
  expect(page.items[2]).toMatchObject({
    kind: 'agent',
    status: 'open',
    reviewUrl: `http://localhost:5173/tx/${older}`,
  })
  expect(page.nextCursor).toBeNull()
})

test('an item carries the review, never the arguments or prepared bytes', async () => {
  const grant = await connect('client-a')
  await request(grant, {
    candidateJson: JSON.stringify({
      transaction: 'c2lnbmVk',
      account: WALLET,
      network: 'devnet',
      review: {
        title: 'Send SOL',
        description: 'd',
        actionLabel: 'Send',
        fields: [{ label: 'Amount', value: '0.01 SOL' }],
      },
      blockhash: 'b',
      lastValidBlockHeight: '1',
      execution: { requestId: 'secret' },
    }),
    status: 'submitting',
    signature: SIGNATURE,
    account: WALLET,
  })
  const [item] = (await list()).items
  expect(item?.kind === 'agent' && item.review.fields).toEqual([
    { label: 'Amount', value: '0.01 SOL' },
  ])
  const text = JSON.stringify(item)
  for (const secret of [
    'argumentsJson',
    'amountLamports',
    'c2lnbmVk',
    'secret',
  ])
    expect(text).not.toContain(secret)
})

test('status groups follow the derived status, so an old open link is expired', async () => {
  const grant = await connect('client-a')
  const stale = await request(grant, {
    createdAt: NOON - 20 * MINUTE,
    expiresAt: NOON - 5 * MINUTE,
  })
  const open = await request(grant, { createdAt: NOON - 10 * MINUTE })
  const failed = await request(grant, {
    status: 'failed',
    signature: SIGNATURE,
    errorCode: 'chain_failed',
    createdAt: NOON - 3 * MINUTE,
  })
  const unknown = await request(grant, {
    status: 'unknown',
    signature: SIGNATURE,
    createdAt: NOON - 2 * MINUTE,
  })
  const pendingDeposit = await transfer({
    status: 'pending',
    createdAt: NOON - MINUTE,
  })
  const all = await list()
  expect(all.counts).toEqual({
    pending: 3,
    confirmed: 0,
    failed: 1,
    expired: 1,
  })
  expect((await list({ status: 'pending' })).items.map((i) => i.id)).toEqual([
    pendingDeposit,
    unknown,
    open,
  ])
  expect((await list({ status: 'expired' })).items.map((i) => i.id)).toEqual([
    stale,
  ])
  expect((await list({ status: 'expired' })).items[0]).toMatchObject({
    status: 'expired',
    reviewUrl: null,
  })
  const failedPage = await list({ status: 'failed' })
  expect(failedPage.items.map((i) => i.id)).toEqual([failed])
  expect(failedPage.items[0]).toMatchObject({ reason: 'chain_failed' })
  // Counts cover every group regardless of the status filter.
  expect(failedPage.counts).toEqual(all.counts)
})

test('a disconnected client leaves its open link unavailable and its history named', async () => {
  const grant = await connect('client-a', {
    status: 'revoked',
    clientName: 'Grok',
  })
  const open = await request(grant)
  const done = await request(grant, {
    status: 'confirmed',
    signature: SIGNATURE,
    createdAt: NOON - MINUTE,
  })
  const page = await list()
  expect(page.items.map((i) => i.id)).toEqual([open, done])
  expect(page.items[0]).toMatchObject({
    status: 'unavailable',
    connected: false,
    clientName: 'Grok',
  })
  expect(page.counts).toEqual({
    pending: 0,
    confirmed: 1,
    failed: 0,
    expired: 1,
  })
})

test('kind, client, delivery and address narrow the feed', async () => {
  const grant = await connect('client-a')
  const other = await connect('client-b', { clientName: 'Claude Code' })
  const swap = await request(grant, {
    toolName: 'jupiter_swap',
    argumentsJson: JSON.stringify({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      amount: '1',
      maxSlippageBps: 50,
    }),
    reviewJson: JSON.stringify({
      title: 'Swap SOL for USDC',
      description: 'd',
      actionLabel: 'Swap',
      fields: [],
    }),
    delivery: 'embedded',
    account: WALLET,
    counterparty: null,
    status: 'confirmed',
    signature: SIGNATURE,
    createdAt: NOON - MINUTE,
  })
  const send = await request(other, {
    creatorClientId: 'client-b',
    delivery: 'local',
    account: OTHER,
    createdAt: NOON - 2 * MINUTE,
  })
  const deposit = await transfer({ createdAt: NOON - 3 * MINUTE })
  const withdrawal = await transfer({
    direction: 'out',
    counterparty: RECIPIENT,
    createdAt: NOON - 4 * MINUTE,
  })
  const perp = await request(grant, {
    toolName: 'phoenix_market_order',
    argumentsJson: JSON.stringify({ symbol: 'SOL', side: 'buy', size: '1' }),
    reviewJson: JSON.stringify({
      title: 'Place a Phoenix market order',
      description: 'd',
      actionLabel: 'Place',
      fields: [],
    }),
    delivery: 'link',
    counterparty: null,
    createdAt: NOON - 5 * MINUTE,
  })
  const ids = async (filter: Partial<TransactionsFilter>) =>
    (await list(filter)).items.map((i) => i.id)
  expect(await ids({})).toEqual([swap, send, deposit, withdrawal, perp])
  expect(await ids({ kind: 'agent' })).toEqual([swap, send, perp])
  expect(await ids({ kind: 'swap' })).toEqual([swap])
  expect(await ids({ kind: 'perp' })).toEqual([perp])
  expect(await ids({ kind: 'deposit' })).toEqual([deposit])
  expect(await ids({ kind: 'withdrawal' })).toEqual([withdrawal])
  expect(await ids({ client: 'client-b' })).toEqual([send])
  expect(await ids({ delivery: 'embedded' })).toEqual([swap])
  expect(await ids({ kind: 'perp', delivery: 'embedded' })).toEqual([])
  // The signing wallet, the recipient and the user's own wallet all match.
  expect(await ids({ address: OTHER })).toEqual([send, deposit])
  expect(await ids({ address: RECIPIENT })).toEqual([send, withdrawal])
  expect(await ids({ address: WALLET })).toEqual([swap, deposit, withdrawal])
  expect(await ids({ address: '1'.repeat(32) })).toEqual([])
  expect((await list({ kind: 'withdrawal' })).counts).toEqual({
    pending: 0,
    confirmed: 1,
    failed: 0,
    expired: 0,
  })
})

test('pages continue across both ledgers with a kind-aware cursor', async () => {
  const grant = await connect('client-a')
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    ids.push(
      i % 2
        ? await transfer({ createdAt: NOON - i * MINUTE })
        : await request(grant, { createdAt: NOON - i * MINUTE }),
    )
  }
  const first = await list({ limit: 2 })
  expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 2))
  expect(first.nextCursor).not.toBeNull()
  const cursor = parseTransactionsCursor(first.nextCursor!)
  expect(cursor).toMatchObject({ id: ids[1], kind: 'deposit' })
  const second = await list({ limit: 2, before: cursor! })
  expect(second.items.map((i) => i.id)).toEqual(ids.slice(2, 4))
  const third = await list({
    limit: 2,
    before: parseTransactionsCursor(second.nextCursor!)!,
  })
  expect(third.items.map((i) => i.id)).toEqual(ids.slice(4))
  expect(third.nextCursor).toBeNull()
  expect(parseTransactionsCursor('1_a.payment')).toBeNull()
  expect(parseTransactionsCursor('nonsense')).toBeNull()
})

test('one transaction can be read by its owner only', async () => {
  const grant = await connect('client-a')
  const id = await request(grant, {
    status: 'confirmed',
    signature: SIGNATURE,
  })
  const deposit = await transfer()
  expect(await readTransaction(env(), user, id, { now: NOON })).toMatchObject({
    kind: 'agent',
    id,
    status: 'confirmed',
  })
  expect(
    await readTransaction(env(), user, deposit, { now: NOON }),
  ).toMatchObject({ kind: 'deposit', id: deposit })
  expect(await readTransaction(env(), 'someone-else', id)).toBeNull()
  expect(await readTransaction(env(), user, 'missing')).toBeNull()
})

test.each(['submitting', 'expired'] as const)(
  'a %s request recovers chain evidence when read',
  async (status) => {
    const grant = await connect('client-a')
    const id = await request(grant, {
      status,
      signature: SIGNATURE,
      account: WALLET,
      candidateJson: JSON.stringify({
        transaction: 'c2lnbmVk',
        account: WALLET,
        network: 'devnet',
        review: {
          title: 'Send SOL',
          description: 'd',
          actionLabel: 'Send',
          fields: [],
        },
        blockhash: 'b',
        lastValidBlockHeight: '1',
      }),
    })
    const rpc: TransactionRpc = {
      accounts: {} as TransactionRpc['accounts'],
      genesisHash: async () => SOLANA_NETWORKS.devnet.genesisHash,
      latestBlockhash: () => Promise.reject(new Error('unused')),
      blockHeight: async () => 1n,
      send: async () => SIGNATURE,
      status: async () => ({
        err: null,
        slot: 42n,
        confirmationStatus: 'finalized',
      }),
    }
    const item = await readTransaction(env(), user, id, { now: NOON, rpc })
    expect(item).toMatchObject({
      kind: 'agent',
      status: 'confirmed',
      receipt: { signature: SIGNATURE, slot: '42', commitment: 'finalized' },
    })
  },
)

test('a pending withdrawal asks the chain once when it is read', async () => {
  const id = await transfer({
    direction: 'out',
    status: 'pending',
    signature: SIGNATURE,
    source: 'withdrawal',
  })
  const landed: TransactionRpc = {
    accounts: {} as TransactionRpc['accounts'],
    genesisHash: async () => SOLANA_NETWORKS.devnet.genesisHash,
    latestBlockhash: () => Promise.reject(new Error('unused')),
    blockHeight: async () => 1n,
    send: async () => SIGNATURE,
    status: async () => ({
      err: null,
      slot: 77n,
      confirmationStatus: 'confirmed',
    }),
  }
  expect(
    await readTransaction(env(), user, id, { now: NOON, rpc: landed }),
  ).toMatchObject({ kind: 'withdrawal', status: 'confirmed', slot: '77' })
  const rejected = await transfer({
    direction: 'out',
    status: 'pending',
    signature: '6'.repeat(87),
    source: 'withdrawal',
  })
  const failed: TransactionRpc = {
    ...landed,
    status: async () => ({
      err: { Custom: 1 },
      slot: 78n,
      confirmationStatus: 'finalized',
    }),
  }
  expect(
    await readTransaction(env(), user, rejected, { now: NOON, rpc: failed }),
  ).toMatchObject({ kind: 'withdrawal', status: 'failed' })
  // A provider that cannot say leaves the row pending.
  const silent = await transfer({
    direction: 'out',
    status: 'pending',
    signature: '7'.repeat(87),
    source: 'withdrawal',
  })
  const unknown: TransactionRpc = { ...landed, status: async () => null }
  expect(
    await readTransaction(env(), user, silent, { now: NOON, rpc: unknown }),
  ).toMatchObject({ kind: 'withdrawal', status: 'pending' })
})

test('retired transaction tools retain their stored review in history', async () => {
  const grant = await connect('client-a')
  const review = {
    title: 'Historical trade',
    description: 'Saved review',
    actionLabel: 'Trade',
    fields: [],
  }
  const id = await request(grant, {
    toolName: 'retired_trade',
    reviewJson: JSON.stringify(review),
  })
  const page = await listTransactions(env(), user, { limit: 50 }, { now: NOON })
  expect(page.items.find((item) => item.id === id)).toMatchObject({ review })
})

test('a trading tool’s trade summary reaches the feed with its review', async () => {
  const grant = await connect('client-a')
  const trade: PerpTrade = {
    kind: 'perp',
    venue: 'phoenix',
    action: 'order',
    symbol: 'SOL',
    side: 'buy',
    orderType: 'market',
    size: '0.1',
    worstPrice: '110.15',
    notionalUsd: '10.96',
  }
  const id = await request(grant, {
    toolName: 'phoenix_market_order',
    argumentsJson: JSON.stringify({ symbol: 'SOL', side: 'buy', size: '0.1' }),
    network: 'mainnet',
    counterparty: null,
    reviewJson: JSON.stringify({
      title: 'Place a Phoenix market order',
      description: 'd',
      actionLabel: 'Place',
      fields: [],
      trade,
    }),
  })
  const item = (await list()).items.find((each) => each.id === id)
  expect(item?.kind === 'agent' && item.review.trade).toEqual(trade)
})

test('a confirmed perp order learns its fill when read, once Phoenix has it', async () => {
  const grant = await connect('client-a')
  const receipt = { signature: SIGNATURE, slot: '42', commitment: 'finalized' }
  const id = await request(grant, {
    toolName: 'phoenix_market_order',
    argumentsJson: JSON.stringify({ symbol: 'SOL', side: 'buy', size: '0.1' }),
    network: 'mainnet',
    delivery: 'embedded',
    counterparty: null,
    status: 'confirmed',
    signature: SIGNATURE,
    account: WALLET,
    receiptJson: JSON.stringify(receipt),
    reviewJson: JSON.stringify({
      title: 'Place a Phoenix market order',
      description: 'd',
      actionLabel: 'Place',
      fields: [],
      trade: {
        kind: 'perp',
        venue: 'phoenix',
        action: 'order',
        orderType: 'market',
        symbol: 'SOL',
        side: 'buy',
        size: '0.1',
      },
    }),
  })
  const asked: string[] = []
  let indexed = false
  const tradeFacts = {
    transaction: () => Promise.reject(new Error('not a swap')),
    fills: async (wallet: string, symbol: string, since: number) => {
      asked.push(`${wallet} ${symbol} ${since}`)
      return indexed
        ? [
            {
              time: '2026-10-10T12:00:01Z',
              size: 0.1,
              price: 109.6,
              feeUsdc: 0.0038,
              realizedPnlUsdc: 0,
              signature: SIGNATURE,
            },
          ]
        : []
    },
  }
  // Not indexed yet: the receipt stays as it was.
  expect(
    await readTransaction(env(), user, id, { now: NOON, tradeFacts }),
  ).toMatchObject({ receipt })
  indexed = true
  expect(
    await readTransaction(env(), user, id, { now: NOON, tradeFacts }),
  ).toMatchObject({
    receipt: {
      ...receipt,
      fill: {
        size: '0.1',
        price: '109.6',
        feeUsdc: '0.0038',
        realizedPnlUsdc: '0',
      },
    },
  })
  // Stored: the next read neither asks again nor loses it.
  await readTransaction(env(), user, id, { now: NOON, tradeFacts })
  // Paged back no further than the request's creation.
  expect(asked).toEqual([`${WALLET} SOL ${NOON}`, `${WALLET} SOL ${NOON}`])
  const [listed] = (await list()).items
  expect(listed?.kind === 'agent' && listed.receipt?.fill?.price).toBe('109.6')
})
