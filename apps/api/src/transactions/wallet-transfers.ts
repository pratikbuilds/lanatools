import { and, desc, eq, ne, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { address, createSolanaRpc, signature } from '@solana/kit'
import {
  paymentActivity,
  paymentSigner,
  transactionRequest,
  walletTransfer,
} from '../db/schema'
import { PAYMENT_NETWORKS, RPC_TIMEOUT_MS } from '../solana/network'
import type { SolanaNetwork } from '../solana/network'

type Network = SolanaNetwork['name']

/** The display symbol LanaTools knows for an asset, or null. */
export function assetSymbol(network: Network, mint: string) {
  if (mint === 'native') return 'SOL'
  if (mint === PAYMENT_NETWORKS[network].usdcMint) return 'USDC'
  return null
}

/**
 * Records a withdrawal the user is sending from the Wallet page, before it
 * is relayed. A retry of the same signed transaction records nothing new.
 */
export async function recordWithdrawal(
  database: D1Database,
  input: {
    userId: string
    wallet: string
    network: Network
    mint: string
    decimals: number
    amount: bigint
    counterparty: string
    signature: string
    now?: number
  },
) {
  const now = input.now ?? Date.now()
  const id = crypto.randomUUID()
  await drizzle(database)
    .insert(walletTransfer)
    .values({
      id,
      privyUserId: input.userId,
      wallet: input.wallet,
      direction: 'out',
      network: input.network,
      mint: input.mint,
      symbol: assetSymbol(input.network, input.mint),
      decimals: input.decimals,
      amountAtomic: input.amount.toString(),
      counterparty: input.counterparty,
      signature: input.signature,
      status: 'pending',
      source: 'withdrawal',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
  return id
}

/** Marks every pending row of one transaction as confirmed or failed. */
export async function settleWalletTransfer(
  database: D1Database,
  input: {
    userId: string
    signature: string
    status: 'confirmed' | 'failed'
    slot?: string | undefined
    blockTime?: number | undefined
    now?: number
  },
) {
  const result = await drizzle(database)
    .update(walletTransfer)
    .set({
      status: input.status,
      ...(input.slot === undefined ? {} : { slot: input.slot }),
      ...(input.blockTime === undefined ? {} : { blockTime: input.blockTime }),
      updatedAt: input.now ?? Date.now(),
    })
    .where(
      and(
        eq(walletTransfer.privyUserId, input.userId),
        eq(walletTransfer.signature, input.signature),
        eq(walletTransfer.status, 'pending'),
      ),
    )
    .run()
  return result.meta.changes
}

export type WalletHistoryEntry = {
  signature: string
  slot: bigint
  blockTime: bigint | null
  err: unknown
}

export type TokenBalanceEntry = {
  accountIndex: number
  mint: string
  owner: string | null
  amount: bigint
  decimals: number
}

/** The parts of a parsed transaction the sync reads. */
export type ParsedWalletTransaction = {
  slot: bigint
  blockTime: bigint | null
  err: unknown
  /** Account public keys, the fee payer first. */
  accountKeys: string[]
  fee: bigint
  preBalances: bigint[]
  postBalances: bigint[]
  preTokenBalances: TokenBalanceEntry[]
  postTokenBalances: TokenBalanceEntry[]
}

export type WalletHistoryRpc = {
  /** Newest first, as the RPC returns them. */
  signatures: (
    wallet: string,
    options: { before?: string; until?: string; limit: number },
  ) => Promise<WalletHistoryEntry[]>
  transaction: (signature: string) => Promise<ParsedWalletTransaction | null>
}

/** The most signatures one RPC call returns. */
export const WALLET_HISTORY_PAGE = 1000

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const big = (value: unknown) =>
  typeof value === 'bigint'
    ? value
    : typeof value === 'number' || typeof value === 'string'
      ? BigInt(value)
      : 0n

function tokenBalance(value: unknown): TokenBalanceEntry | null {
  const entry = record(value)
  const amount = record(entry.uiTokenAmount)
  if (typeof entry.accountIndex !== 'number' || typeof entry.mint !== 'string')
    return null
  return {
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    owner: typeof entry.owner === 'string' ? entry.owner : null,
    amount: big(amount.amount),
    decimals: typeof amount.decimals === 'number' ? amount.decimals : 0,
  }
}

/** Reads a `jsonParsed` transaction into the fields the sync uses. */
export function parseWalletTransaction(
  value: unknown,
): ParsedWalletTransaction | null {
  const tx = record(value)
  const meta = record(tx.meta)
  const message = record(record(tx.transaction).message)
  const accountKeys = list(message.accountKeys).map((key) =>
    typeof key === 'string' ? key : String(record(key).pubkey ?? ''),
  )
  const preBalances = list(meta.preBalances).map(big)
  const postBalances = list(meta.postBalances).map(big)
  if (
    accountKeys.length === 0 ||
    accountKeys.some((key) => !key) ||
    preBalances.length !== accountKeys.length ||
    postBalances.length !== accountKeys.length
  )
    return null
  return {
    slot: big(tx.slot),
    blockTime:
      tx.blockTime === null || tx.blockTime === undefined
        ? null
        : big(tx.blockTime),
    err: meta.err ?? null,
    accountKeys,
    fee: big(meta.fee),
    preBalances,
    postBalances,
    preTokenBalances: list(meta.preTokenBalances)
      .map(tokenBalance)
      .filter((entry): entry is TokenBalanceEntry => entry !== null),
    postTokenBalances: list(meta.postTokenBalances)
      .map(tokenBalance)
      .filter((entry): entry is TokenBalanceEntry => entry !== null),
  }
}

export function walletHistoryRpc(rpcUrl: string): WalletHistoryRpc {
  const rpc = createSolanaRpc(rpcUrl)
  const send = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  return {
    async signatures(wallet, { before, until, limit }) {
      const page = await rpc
        .getSignaturesForAddress(address(wallet), {
          ...(before ? { before: signature(before) } : {}),
          ...(until ? { until: signature(until) } : {}),
          limit,
          commitment: 'confirmed',
        })
        .send(send())
      return page.map((entry) => ({
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime,
        err: entry.err,
      }))
    },
    async transaction(value) {
      const tx = await rpc
        .getTransaction(signature(value), {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
        .send(send())
      return tx ? parseWalletTransaction(tx) : null
    },
  }
}

export type AssetChange = {
  mint: string
  decimals: number
  /** From the wallet's side: positive came in, negative went out. */
  delta: bigint
  counterparty: string
}

/**
 * The other party of a movement: the one account that changed the other
 * way when there is exactly one, otherwise the fee payer. The wallet itself
 * is never its own counterparty.
 */
function counterpartyOf(
  candidates: string[],
  feePayer: string,
  wallet: string,
) {
  const others = [...new Set(candidates.filter((each) => each !== wallet))]
  if (others.length === 1 && others[0]) return others[0]
  if (feePayer !== wallet) return feePayer
  return others[0] ?? wallet
}

/**
 * What a transaction moved into or out of the wallet, one entry per asset.
 * The fee is added back for a wallet that paid it, so an amount is what
 * reached the other party, not what the wallet's balance lost.
 */
export function walletChanges(
  tx: ParsedWalletTransaction,
  wallet: string,
): AssetChange[] {
  const changes: AssetChange[] = []
  const feePayer = tx.accountKeys[0] ?? wallet
  const lamports = tx.accountKeys.map((key, index) => {
    const pre = tx.preBalances[index] ?? 0n
    const post = tx.postBalances[index] ?? 0n
    return { key, delta: post - pre + (index === 0 ? tx.fee : 0n) }
  })
  const own = lamports.find((entry) => entry.key === wallet)
  if (own && own.delta !== 0n) {
    const candidates = lamports
      .filter((entry) => entry.key !== wallet && entry.delta !== 0n)
      .filter((entry) => entry.delta > 0n !== own.delta > 0n)
      .map((entry) => entry.key)
    changes.push({
      mint: 'native',
      decimals: 9,
      delta: own.delta,
      counterparty: counterpartyOf(candidates, feePayer, wallet),
    })
  }
  // Token balances are per account; sum them per owner and mint.
  const byOwner = new Map<string, { decimals: number; delta: bigint }>()
  const keyOf = (owner: string, mint: string) => `${owner}\n${mint}`
  for (const [side, entries] of [
    [-1n, tx.preTokenBalances],
    [1n, tx.postTokenBalances],
  ] as const) {
    for (const entry of entries) {
      if (!entry.owner) continue
      const key = keyOf(entry.owner, entry.mint)
      const current = byOwner.get(key) ?? {
        decimals: entry.decimals,
        delta: 0n,
      }
      current.delta += side * entry.amount
      byOwner.set(key, current)
    }
  }
  for (const [key, change] of byOwner) {
    const [owner, mint] = key.split('\n') as [string, string]
    if (owner !== wallet || change.delta === 0n) continue
    const candidates = [...byOwner]
      .filter(
        ([otherKey, other]) =>
          otherKey.endsWith(`\n${mint}`) &&
          other.delta !== 0n &&
          other.delta > 0n !== change.delta > 0n,
      )
      .map(([otherKey]) => otherKey.split('\n')[0] as string)
    changes.push({
      mint,
      decimals: change.decimals,
      delta: change.delta,
      counterparty: counterpartyOf(candidates, feePayer, wallet),
    })
  }
  return changes
}

/**
 * Brings the wallet's ledger up to date from the chain: inserts transfers
 * newer than the last one it stored, and settles rows still pending once
 * their signature has landed. Signatures that agent transactions or
 * payments already own are skipped, so nothing is listed twice. Runs within
 * the request; nothing is scheduled.
 */
export async function syncWalletTransfers(
  database: D1Database,
  input: {
    userId: string
    network: Network
    rpc: WalletHistoryRpc
    now?: number
  },
): Promise<{ inserted: number; settled: number }> {
  const now = input.now ?? Date.now()
  const db = drizzle(database)
  const signer = await db
    .select({ wallet: paymentSigner.walletAddress })
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, input.userId))
    .get()
  if (!signer) return { inserted: 0, settled: 0 }
  const wallet = signer.wallet
  const mine = eq(walletTransfer.privyUserId, input.userId)
  // The newest transfer already seen on chain; the RPC walks back to it.
  const bookmark = await db
    .select({ signature: walletTransfer.signature })
    .from(walletTransfer)
    .where(
      and(
        mine,
        eq(walletTransfer.wallet, wallet),
        ne(walletTransfer.status, 'pending'),
      ),
    )
    .orderBy(desc(walletTransfer.createdAt), desc(walletTransfer.id))
    .get()

  const entries: WalletHistoryEntry[] = []
  let before: string | undefined
  for (;;) {
    const page = await input.rpc.signatures(wallet, {
      ...(before ? { before } : {}),
      ...(bookmark ? { until: bookmark.signature } : {}),
      limit: WALLET_HISTORY_PAGE,
    })
    entries.push(...page)
    if (page.length < WALLET_HISTORY_PAGE) break
    before = page[page.length - 1]?.signature
  }

  let inserted = 0
  let settled = 0
  // Oldest first, so a failure part way through leaves a contiguous ledger.
  for (const entry of entries.reverse()) {
    const known = await db
      .select({ status: walletTransfer.status })
      .from(walletTransfer)
      .where(and(mine, eq(walletTransfer.signature, entry.signature)))
    if (known.length > 0) {
      if (known.some((row) => row.status === 'pending'))
        settled += await settleWalletTransfer(database, {
          userId: input.userId,
          signature: entry.signature,
          status: entry.err ? 'failed' : 'confirmed',
          slot: entry.slot.toString(),
          blockTime:
            entry.blockTime === null ? undefined : Number(entry.blockTime),
          now,
        })
      continue
    }
    if (entry.err) continue
    const [owned] = await db
      .select({
        count: sql<number>`(select count(*) from ${transactionRequest}
            where ${transactionRequest.creatorUserId} = ${input.userId}
              and ${transactionRequest.signature} = ${entry.signature})
          + (select count(*) from ${paymentActivity}
            where ${paymentActivity.privyUserId} = ${input.userId}
              and ${paymentActivity.signature} = ${entry.signature})`,
      })
      .from(sql`(select 1)`)
    if (owned && owned.count > 0) continue
    const tx = await input.rpc.transaction(entry.signature)
    if (!tx || tx.err) continue
    for (const change of walletChanges(tx, wallet)) {
      const result = await db
        .insert(walletTransfer)
        .values({
          id: crypto.randomUUID(),
          privyUserId: input.userId,
          wallet,
          direction: change.delta > 0n ? 'in' : 'out',
          network: input.network,
          mint: change.mint,
          symbol: assetSymbol(input.network, change.mint),
          decimals: change.decimals,
          amountAtomic: (change.delta < 0n
            ? -change.delta
            : change.delta
          ).toString(),
          counterparty: change.counterparty,
          signature: entry.signature,
          status: 'confirmed',
          slot: tx.slot.toString(),
          blockTime: tx.blockTime === null ? null : Number(tx.blockTime),
          source: 'chain_sync',
          createdAt: tx.blockTime === null ? now : Number(tx.blockTime) * 1000,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run()
      inserted += result.meta.changes
    }
  }
  return { inserted, settled }
}
