import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { D1Database } from '@cloudflare/workers-types'
import {
  paymentActivity,
  paymentSigner,
  transactionRequest,
  walletTransfer,
} from '../db/schema'
import { testDatabase } from '../test-database'
import {
  assetSymbol,
  parseWalletTransaction,
  recordWithdrawal,
  settleWalletTransfer,
  syncWalletTransfers,
  walletChanges,
} from './wallet-transfers'
import type {
  ParsedWalletTransaction,
  WalletHistoryEntry,
  WalletHistoryRpc,
} from './wallet-transfers'

const WALLET = 'G7fu2vBDEZ9SYM4agJPshffJQUmyg6UCEEUnxuYRAMuq'
const FRIEND = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const OTHER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const NOON = Date.UTC(2026, 9, 10, 12)

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

let user: string
beforeEach(async () => {
  user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-id',
    walletAddress: WALLET,
    policyId: 'policy',
    status: 'enabled',
    updatedAt: NOON,
  })
})

function solTransfer(
  from: string,
  to: string,
  lamports: bigint,
  { slot = 100n, blockTime = 1_791_633_600n, fee = 5_000n } = {},
): ParsedWalletTransaction {
  return {
    slot,
    blockTime,
    err: null,
    accountKeys: [from, to, '11111111111111111111111111111111'],
    fee,
    preBalances: [1_000_000_000n, 2_000_000_000n, 1n],
    postBalances: [
      1_000_000_000n - lamports - fee,
      2_000_000_000n + lamports,
      1n,
    ],
    preTokenBalances: [],
    postTokenBalances: [],
  }
}

function tokenTransfer(
  fromOwner: string,
  toOwner: string,
  amount: bigint,
  { slot = 101n, blockTime = 1_791_633_660n } = {},
): ParsedWalletTransaction {
  return {
    slot,
    blockTime,
    err: null,
    accountKeys: [
      fromOwner,
      'from-ata',
      'to-ata',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    ],
    fee: 5_000n,
    preBalances: [10n, 2n, 2n, 1n],
    postBalances: [5n, 2n, 2n, 1n],
    preTokenBalances: [
      {
        accountIndex: 1,
        mint: USDC,
        owner: fromOwner,
        amount: 50_000_000n,
        decimals: 6,
      },
      { accountIndex: 2, mint: USDC, owner: toOwner, amount: 0n, decimals: 6 },
    ],
    postTokenBalances: [
      {
        accountIndex: 1,
        mint: USDC,
        owner: fromOwner,
        amount: 50_000_000n - amount,
        decimals: 6,
      },
      { accountIndex: 2, mint: USDC, owner: toOwner, amount, decimals: 6 },
    ],
  }
}

/** A chain with a fixed history; `calls` records what was asked. */
function fakeChain(
  history: Array<{
    entry: WalletHistoryEntry
    tx: ParsedWalletTransaction | null
  }>,
) {
  const calls: string[] = []
  const rpc: WalletHistoryRpc = {
    tokenAccounts: async () => [],
    async signatures(_wallet, { before, until, limit }) {
      calls.push(`signatures before=${before ?? ''} until=${until ?? ''}`)
      // Newest first, as the RPC returns them, cut at `until` as the RPC does.
      let entries = history.map((h) => h.entry)
      if (before)
        entries = entries.slice(
          entries.findIndex((e) => e.signature === before) + 1,
        )
      if (until) {
        const stop = entries.findIndex((e) => e.signature === until)
        if (stop >= 0) entries = entries.slice(0, stop)
      }
      return entries.slice(0, limit)
    },
    async transaction(signature) {
      calls.push(`transaction ${signature}`)
      return history.find((h) => h.entry.signature === signature)?.tx ?? null
    },
  }
  return { rpc, calls }
}

const entry = (
  signature: string,
  extra: Partial<WalletHistoryEntry> = {},
): WalletHistoryEntry => ({
  signature,
  slot: 100n,
  blockTime: 1_791_633_600n,
  err: null,
  ...extra,
})

const rows = () =>
  drizzle(db)
    .select()
    .from(walletTransfer)
    .where(eq(walletTransfer.privyUserId, user))
    .orderBy(walletTransfer.createdAt)

test('symbols are known for SOL and the network USDC only', () => {
  expect(assetSymbol('devnet', 'native')).toBe('SOL')
  expect(assetSymbol('devnet', USDC)).toBe('USDC')
  expect(assetSymbol('mainnet', USDC)).toBeNull()
  expect(assetSymbol('devnet', OTHER)).toBeNull()
})

test('a withdrawal is recorded pending, once, then settled', async () => {
  const input = {
    userId: user,
    wallet: WALLET,
    network: 'devnet' as const,
    mint: 'native',
    decimals: 9,
    amount: 500_000_000n,
    counterparty: FRIEND,
    signature: 'sig-withdrawal',
    now: NOON,
  }
  await recordWithdrawal(db, input)
  await recordWithdrawal(db, input)
  expect(await rows()).toMatchObject([
    {
      direction: 'out',
      mint: 'native',
      symbol: 'SOL',
      decimals: 9,
      amountAtomic: '500000000',
      counterparty: FRIEND,
      status: 'pending',
      source: 'withdrawal',
      createdAt: NOON,
    },
  ])
  expect(
    await settleWalletTransfer(db, {
      userId: user,
      signature: 'sig-withdrawal',
      status: 'confirmed',
      slot: '123',
    }),
  ).toBe(1)
  expect((await rows())[0]).toMatchObject({ status: 'confirmed', slot: '123' })
  // Settled rows are left alone, and so are other users' rows.
  expect(
    await settleWalletTransfer(db, {
      userId: user,
      signature: 'sig-withdrawal',
      status: 'failed',
    }),
  ).toBe(0)
  expect(
    await settleWalletTransfer(db, {
      userId: 'other',
      signature: 'sig-withdrawal',
      status: 'failed',
    }),
  ).toBe(0)
})

test('wallet changes add the fee back and name the other party', () => {
  const out = walletChanges(solTransfer(WALLET, FRIEND, 500_000_000n), WALLET)
  expect(out).toEqual([
    { mint: 'native', decimals: 9, delta: -500_000_000n, counterparty: FRIEND },
  ])
  const incoming = walletChanges(
    solTransfer(FRIEND, WALLET, 100_000_000n),
    WALLET,
  )
  expect(incoming).toEqual([
    { mint: 'native', decimals: 9, delta: 100_000_000n, counterparty: FRIEND },
  ])
  const token = walletChanges(tokenTransfer(OTHER, WALLET, 25_000_000n), WALLET)
  expect(token).toEqual([
    { mint: USDC, decimals: 6, delta: 25_000_000n, counterparty: OTHER },
  ])
  // Not involved: nothing to record.
  expect(walletChanges(solTransfer(FRIEND, OTHER, 1n), WALLET)).toEqual([])
})

test('an ambiguous movement falls back to the fee payer', () => {
  const tx: ParsedWalletTransaction = {
    ...solTransfer(OTHER, WALLET, 10n),
    accountKeys: [OTHER, WALLET, FRIEND],
    preBalances: [100n, 0n, 0n],
    postBalances: [100n - 5_000n - 20n, 10n, 10n],
  }
  // Two accounts lost SOL relative to the wallet's gain? No: one payer split
  // between two recipients; the wallet sees one other mover and takes it.
  expect(walletChanges(tx, WALLET)[0]?.counterparty).toBe(OTHER)
  const split: ParsedWalletTransaction = {
    ...tx,
    accountKeys: [FRIEND, WALLET, OTHER, 'A1111111111111111111111111111111'],
    preBalances: [100n, 0n, 50n, 50n],
    postBalances: [100n - 5_000n, 30n, 35n, 35n],
  }
  // Two counterparties lost SOL; the fee payer stands in.
  expect(walletChanges(split, WALLET)[0]?.counterparty).toBe(FRIEND)
})

test('a jsonParsed transaction is read into balances and keys', () => {
  const parsed = parseWalletTransaction({
    slot: 5,
    blockTime: 1_700_000_000,
    transaction: {
      message: { accountKeys: [{ pubkey: WALLET }, { pubkey: FRIEND }] },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10, 0],
      postBalances: [4000, 1000],
      preTokenBalances: [
        {
          accountIndex: 1,
          mint: USDC,
          owner: FRIEND,
          uiTokenAmount: { amount: '1', decimals: 6 },
        },
      ],
      postTokenBalances: null,
    },
  })
  expect(parsed).toMatchObject({
    slot: 5n,
    blockTime: 1_700_000_000n,
    accountKeys: [WALLET, FRIEND],
    fee: 5000n,
    preBalances: [10n, 0n],
    postBalances: [4000n, 1000n],
    preTokenBalances: [
      { accountIndex: 1, mint: USDC, owner: FRIEND, amount: 1n, decimals: 6 },
    ],
    postTokenBalances: [],
  })
  expect(
    parseWalletTransaction({ meta: {}, transaction: { message: {} } }),
  ).toBeNull()
})

test('a sync inserts deposits, skips what is already recorded, and settles pending withdrawals', async () => {
  const grantId = crypto.randomUUID()
  await drizzle(db).insert(transactionRequest).values({
    id: crypto.randomUUID(),
    toolName: 'jupiter_swap',
    argumentsJson: '{}',
    network: 'devnet',
    creatorUserId: user,
    creatorClientId: 'client',
    creatorGrantId: grantId,
    idempotencyKey: 'k',
    delivery: 'embedded',
    status: 'confirmed',
    signature: 'sig-swap',
    createdAt: NOON,
    updatedAt: NOON,
    expiresAt: NOON,
  })
  await drizzle(db).insert(paymentActivity).values({
    id: crypto.randomUUID(),
    privyUserId: user,
    clientId: 'client',
    grantId,
    method: 'GET',
    origin: 'https://merchant.example',
    path: '/',
    status: 'paid',
    signature: null,
    payerSignature: 'sig-payment',
    createdAt: NOON,
  })
  await recordWithdrawal(db, {
    userId: user,
    wallet: WALLET,
    network: 'devnet',
    mint: 'native',
    decimals: 9,
    amount: 500_000_000n,
    counterparty: FRIEND,
    signature: 'sig-withdrawal',
    // Sent after both deposits landed, so it sorts after them.
    now: NOON + 120_000,
  })
  const { rpc, calls } = fakeChain([
    {
      entry: entry('sig-withdrawal', { slot: 104n, blockTime: 1_791_633_900n }),
      tx: solTransfer(WALLET, FRIEND, 500_000_000n),
    },
    {
      entry: entry('sig-usdc-in', { slot: 103n }),
      tx: tokenTransfer(OTHER, WALLET, 25_000_000n),
    },
    {
      entry: entry('sig-failed', {
        slot: 102n,
        err: { InstructionError: [0, 'Custom'] },
      }),
      tx: null,
    },
    { entry: entry('sig-payment', { slot: 102n }), tx: null },
    { entry: entry('sig-swap', { slot: 101n }), tx: null },
    {
      entry: entry('sig-sol-in', { slot: 100n, blockTime: 1_791_633_600n }),
      tx: solTransfer(FRIEND, WALLET, 100_000_000n),
    },
  ])
  expect(
    await syncWalletTransfers(db, {
      userId: user,
      network: 'devnet',
      rpc,
      now: NOON,
    }),
  ).toEqual({ inserted: 2, settled: 1, more: false })
  // Only transactions it must read are fetched; known signatures are not.
  expect(calls.filter((c) => c.startsWith('transaction'))).toEqual([
    'transaction sig-usdc-in',
    'transaction sig-sol-in',
  ])
  const stored = await rows()
  expect(stored).toMatchObject([
    {
      direction: 'in',
      mint: 'native',
      symbol: 'SOL',
      amountAtomic: '100000000',
      counterparty: FRIEND,
      status: 'confirmed',
      slot: '100',
      blockTime: 1_791_633_600,
      source: 'chain_sync',
      createdAt: 1_791_633_600_000,
    },
    {
      direction: 'in',
      mint: USDC,
      symbol: 'USDC',
      decimals: 6,
      amountAtomic: '25000000',
      counterparty: OTHER,
      status: 'confirmed',
      slot: '101',
      source: 'chain_sync',
    },
    {
      direction: 'out',
      signature: 'sig-withdrawal',
      status: 'confirmed',
      slot: '104',
      blockTime: 1_791_633_900,
      source: 'withdrawal',
      createdAt: NOON + 120_000,
    },
  ])

  // The next sync walks back only to the newest settled row and finds nothing new.
  calls.length = 0
  expect(
    await syncWalletTransfers(db, {
      userId: user,
      network: 'devnet',
      rpc,
      now: NOON,
    }),
  ).toEqual({ inserted: 0, settled: 0, more: false })
  // The bookmark is the newest row the sync inserted, never a withdrawal.
  expect(calls).toEqual(['signatures before= until=sig-withdrawal'])

  // A new deposit after that is picked up.
  {
    const { rpc: later } = fakeChain([
      {
        entry: entry('sig-later', { slot: 200n, blockTime: 1_791_640_000n }),
        tx: solTransfer(OTHER, WALLET, 7n, {
          slot: 200n,
          blockTime: 1_791_640_000n,
        }),
      },
      { entry: entry('sig-withdrawal', { slot: 104n }), tx: null },
      { entry: entry('sig-usdc-in', { slot: 103n }), tx: null },
    ])
    expect(
      await syncWalletTransfers(db, {
        userId: user,
        network: 'devnet',
        rpc: later,
        now: NOON,
      }),
    ).toEqual({ inserted: 1, settled: 0, more: false })
    expect((await rows()).at(-1)).toMatchObject({
      signature: 'sig-later',
      amountAtomic: '7',
      counterparty: OTHER,
    })
  }
})

test('a user without a wallet, or a failed transaction, records nothing', async () => {
  const { rpc } = fakeChain([
    {
      entry: entry('sig-x', { err: { Custom: 1 } }),
      tx: solTransfer(FRIEND, WALLET, 1n),
    },
  ])
  expect(
    await syncWalletTransfers(db, {
      userId: user,
      network: 'devnet',
      rpc,
      now: NOON,
    }),
  ).toEqual({ inserted: 0, settled: 0, more: false })
  expect(
    await syncWalletTransfers(db, {
      userId: 'nobody',
      network: 'devnet',
      rpc,
      now: NOON,
    }),
  ).toEqual({ inserted: 0, settled: 0, more: false })
  expect(await rows()).toEqual([])
})

test('a long history is caught up in bounded pages with durable progress', async () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    entry: entry(`sig-${String(59 - i).padStart(2, '0')}`, {
      slot: BigInt(1000 + 59 - i),
      blockTime: BigInt(1_791_700_000 + 59 - i),
    }),
    tx: solTransfer(FRIEND, WALLET, BigInt(59 - i + 1), {
      slot: BigInt(1000 + 59 - i),
      blockTime: BigInt(1_791_700_000 + 59 - i),
    }),
  }))
  const { rpc, calls } = fakeChain(history)
  const sync = () =>
    syncWalletTransfers(db, { userId: user, network: 'devnet', rpc, now: NOON })
  expect(await sync()).toEqual({ inserted: 25, settled: 0, more: true })
  expect((await rows()).map((r) => r.signature)).toEqual(
    history
      .slice(0, 25)
      .reverse()
      .map((h) => h.entry.signature),
  )
  expect(await sync()).toEqual({ inserted: 25, settled: 0, more: true })
  // The second call walked back only to the newest row the first inserted.
  expect(calls.filter((c) => c.startsWith('signatures')).at(-1)).toBe(
    'signatures before=sig-35 until=',
  )
  expect(await sync()).toEqual({ inserted: 10, settled: 0, more: false })
  expect(await sync()).toEqual({ inserted: 0, settled: 0, more: false })
  expect((await rows()).length).toBe(60)
})

test('a withdrawal confirmed before the first sync does not hide older deposits', async () => {
  await recordWithdrawal(db, {
    userId: user,
    wallet: WALLET,
    network: 'devnet',
    mint: 'native',
    decimals: 9,
    amount: 1n,
    counterparty: FRIEND,
    signature: 'sig-withdrawal',
    now: NOON,
  })
  await settleWalletTransfer(db, {
    userId: user,
    signature: 'sig-withdrawal',
    status: 'confirmed',
  })
  const { rpc, calls } = fakeChain([
    { entry: entry('sig-withdrawal', { slot: 200n }), tx: null },
    {
      entry: entry('sig-old-deposit', { slot: 100n }),
      tx: solTransfer(FRIEND, WALLET, 5n),
    },
  ])
  expect(
    await syncWalletTransfers(db, {
      userId: user,
      network: 'devnet',
      rpc,
      now: NOON,
    }),
  ).toEqual({ inserted: 1, settled: 0, more: false })
  expect(calls[0]).toBe('signatures before= until=')
  expect((await rows()).map((r) => r.signature).sort()).toEqual([
    'sig-old-deposit',
    'sig-withdrawal',
  ])
})

test('signature discovery is bounded and progresses past missing and unchanged transactions', async () => {
  const history = Array.from({ length: 2100 }, (_, i) => ({
    entry: entry(`history-${i}`, { slot: BigInt(3000 - i) }),
    tx:
      i === 26
        ? solTransfer(FRIEND, WALLET, 9n)
        : i === 1
          ? solTransfer(FRIEND, WALLET, 0n)
          : null,
  }))
  const { rpc, calls } = fakeChain(history)
  const sync = () =>
    syncWalletTransfers(db, { userId: user, network: 'devnet', rpc })
  expect(await sync()).toEqual({ inserted: 0, settled: 0, more: true })
  expect(calls.filter((c) => c.startsWith('signatures'))).toHaveLength(1)
  expect(calls.filter((c) => c.startsWith('transaction'))).toHaveLength(25)
  expect(await sync()).toEqual({ inserted: 1, settled: 0, more: true })
  expect(calls.filter((c) => c.startsWith('signatures'))).toEqual([
    'signatures before= until=',
    'signatures before=history-24 until=',
  ])
  expect((await rows())[0]?.signature).toBe('history-26')
})

test('SPL deposits referenced only by the token account are found and deduplicated', async () => {
  const { rpc: tokenRpc } = fakeChain([
    { entry: entry('spl-deposit'), tx: tokenTransfer(FRIEND, WALLET, 10n) },
  ])
  const queried: string[] = []
  const rpc: WalletHistoryRpc = {
    tokenAccounts: async () => ['token-account', 'token-account'],
    signatures: async (wallet, options) => {
      queried.push(wallet)
      return wallet === WALLET ? [] : tokenRpc.signatures(wallet, options)
    },
    transaction: tokenRpc.transaction,
  }
  const sync = () =>
    syncWalletTransfers(db, { userId: user, network: 'devnet', rpc })
  expect(await sync()).toEqual({ inserted: 0, settled: 0, more: true })
  expect(await sync()).toEqual({ inserted: 1, settled: 0, more: false })
  expect(queried).toEqual([WALLET, 'token-account'])
  expect((await rows())[0]).toMatchObject({
    signature: 'spl-deposit',
    mint: USDC,
    amountAtomic: '10',
  })
  expect(await sync()).toEqual({ inserted: 0, settled: 0, more: true })
  expect(await sync()).toEqual({ inserted: 0, settled: 0, more: false })
  expect(await rows()).toHaveLength(1)
})

test('an unverified receipt cannot hide an unrelated deposit', async () => {
  await drizzle(db).insert(paymentActivity).values({
    id: crypto.randomUUID(),
    privyUserId: user,
    clientId: 'client',
    grantId: 'grant',
    method: 'GET',
    origin: 'https://merchant.example',
    path: '/',
    status: 'paid',
    signature: 'unrelated-deposit',
    payerSignature: 'actual-payment',
    createdAt: NOON,
  })
  const { rpc } = fakeChain([
    { entry: entry('unrelated-deposit'), tx: solTransfer(FRIEND, WALLET, 11n) },
    { entry: entry('actual-payment'), tx: solTransfer(WALLET, FRIEND, 4n) },
  ])
  expect(
    await syncWalletTransfers(db, { userId: user, network: 'devnet', rpc }),
  ).toEqual({ inserted: 1, settled: 0, more: false })
  expect((await rows()).map((row) => row.signature)).toEqual([
    'unrelated-deposit',
  ])
})
