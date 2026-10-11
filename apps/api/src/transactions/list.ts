import { and, desc, eq, like, or, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type {
  AgentTransactionItem,
  TransactionActivityItem,
  TransactionStatusGroup,
  TransactionsPage,
  TransactionsQuery,
  WalletTransferItem,
} from '@lanatools/contracts'
import { mcpGrant, transactionRequest, walletTransfer } from '../db/schema'
import {
  configuration,
  liveAccess,
  observeTransactionLink,
  projectTransactionLink,
} from './requests'
import type {
  ExecutionOptions,
  TransactionExecutionEnv,
  TransactionLinkEnv,
  TransactionRequestRow,
} from './requests'
import {
  observeSubmission,
  transactionRpc,
  verifyRpcNetwork,
} from './submission'
import { settleWalletTransfer } from './wallet-transfers'

/** Transactions fetched per request; the dashboard asks for older ones on scroll. */
export const TRANSACTIONS_PAGE_SIZE = 50

type Kind = TransactionActivityItem['kind']

export type TransactionsCursor = { createdAt: number; id: string; kind: Kind }

export function parseTransactionsCursor(
  value: string,
): TransactionsCursor | null {
  const match = /^(\d{1,15})_([\w-]{1,64})\.(agent|withdrawal|deposit)$/.exec(
    value,
  )
  if (!match?.[1] || !match[2] || !match[3]) return null
  return {
    createdAt: Number(match[1]),
    id: match[2],
    kind: match[3] as Kind,
  }
}

export type TransactionsFilter = Omit<TransactionsQuery, 'before'> & {
  before?: TransactionsCursor | undefined
  limit: number
}

type ListOptions = Pick<ExecutionOptions, 'now' | 'tools'>

// A request that was never signed can still expire or lose its grant, so its
// stored status is not its group. This mirrors `projectTransactionLink`.
function agentGroup(now: number) {
  return sql<TransactionStatusGroup>`case
    when ${transactionRequest.signature} is null and (
      ${transactionRequest.status} in ('open', 'preparing', 'ready', 'transaction_expired')
      or (${transactionRequest.status} = 'expired' and ${transactionRequest.errorCode} = 'blockhash_expired'))
      then case when not (${liveAccess}) or ${transactionRequest.expiresAt} <= ${now} then 'expired' else 'pending' end
    when ${transactionRequest.status} in ('submitting', 'unknown') then 'pending'
    when ${transactionRequest.status} = 'confirmed' then 'confirmed'
    when ${transactionRequest.status} = 'failed' then 'failed'
    else 'expired'
  end`
}

/** Groups that the wallet ledger can hold; `expired` never applies to it. */
const WALLET_STATUS: Record<TransactionStatusGroup, SQL | undefined> = {
  pending: sql`${walletTransfer.status} = 'pending'`,
  confirmed: sql`${walletTransfer.status} = 'confirmed'`,
  failed: sql`${walletTransfer.status} = 'failed'`,
  expired: sql`0`,
}

/** Agent kinds that are one family of trading tools. */
const TOOL_FAMILIES = {
  swap: eq(transactionRequest.toolName, 'jupiter_swap'),
  // Every Phoenix trade tool is named phoenix_*; no other tool starts so.
  perp: like(transactionRequest.toolName, 'phoenix_%'),
}

function agentSelected(
  userId: string,
  filter: Omit<TransactionsFilter, 'status' | 'before' | 'limit'>,
) {
  if (filter.kind === 'withdrawal' || filter.kind === 'deposit') return null
  return and(
    eq(transactionRequest.creatorUserId, userId),
    filter.kind === 'swap' || filter.kind === 'perp'
      ? TOOL_FAMILIES[filter.kind]
      : undefined,
    filter.client === undefined
      ? undefined
      : eq(transactionRequest.creatorClientId, filter.client),
    filter.delivery === undefined
      ? undefined
      : eq(transactionRequest.delivery, filter.delivery),
    filter.address === undefined
      ? undefined
      : or(
          eq(transactionRequest.account, filter.address),
          eq(transactionRequest.counterparty, filter.address),
        ),
  )
}

function walletSelected(
  userId: string,
  filter: Omit<TransactionsFilter, 'status' | 'before' | 'limit'>,
) {
  // Wallet transfers have no client or signing method to match.
  if (
    filter.kind === 'agent' ||
    filter.kind === 'swap' ||
    filter.kind === 'perp'
  )
    return null
  if (filter.client !== undefined || filter.delivery !== undefined) return null
  return and(
    eq(walletTransfer.privyUserId, userId),
    filter.kind === undefined
      ? undefined
      : eq(walletTransfer.direction, filter.kind === 'deposit' ? 'in' : 'out'),
    filter.address === undefined
      ? undefined
      : or(
          eq(walletTransfer.counterparty, filter.address),
          eq(walletTransfer.wallet, filter.address),
        ),
  )
}

type AgentRow = {
  row: TransactionRequestRow
  available: number
  clientName: string | null
  grantStatus: 'pending' | 'active' | 'revoked' | null
}

function agentItem(
  found: AgentRow,
  webOrigin: string,
  now: number,
  tools: ListOptions['tools'],
): AgentTransactionItem {
  const link = projectTransactionLink(
    found.row,
    found.available === 1,
    now,
    tools,
  )
  const signable = ['open', 'preparing', 'ready', 'transaction_expired']
  return {
    kind: 'agent',
    id: link.id,
    tool: link.tool,
    delivery: found.row.delivery,
    status: link.status,
    network: link.network,
    clientId: found.row.creatorClientId,
    clientName: found.clientName,
    connected: found.grantStatus === 'active',
    review: link.review,
    account: link.account,
    counterparty: found.row.counterparty,
    signature: link.signature,
    receipt: link.receipt,
    reviewUrl:
      found.row.delivery === 'link' && signable.includes(link.status)
        ? `${webOrigin}/tx/${link.id}`
        : null,
    reason: found.row.errorCode,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
  }
}

function walletItem(
  row: typeof walletTransfer.$inferSelect,
): WalletTransferItem {
  return {
    kind: row.direction === 'in' ? 'deposit' : 'withdrawal',
    id: row.id,
    status: row.status,
    network: row.network,
    mint: row.mint,
    symbol: row.symbol,
    decimals: row.decimals,
    amountAtomic: row.amountAtomic,
    counterparty: row.counterparty,
    signature: row.signature,
    slot: row.slot,
    createdAt: row.createdAt,
  }
}

function agentQuery(database: D1Database) {
  return (
    drizzle(database)
      .select({
        row: transactionRequest,
        available: sql<number>`case when ${liveAccess} then 1 else 0 end`,
        clientName: mcpGrant.clientName,
        grantStatus: mcpGrant.status,
      })
      .from(transactionRequest)
      // The current grant for this client names it and says whether it is
      // still connected, as the Activity feed does.
      .leftJoin(
        mcpGrant,
        and(
          eq(mcpGrant.privyUserId, transactionRequest.creatorUserId),
          eq(mcpGrant.clientId, transactionRequest.creatorClientId),
        ),
      )
  )
}

/**
 * One page of the user's transactions, newest first: agent requests and
 * wallet transfers merged from bounded reads of each table, as the Activity
 * feed merges its two ledgers. Counts cover every status group under the
 * other filters, so the status tabs can show them. Every read is scoped to
 * the signed-in user.
 */
export async function listTransactions(
  env: TransactionLinkEnv,
  userId: string,
  filter: TransactionsFilter,
  options: ListOptions = {},
): Promise<TransactionsPage> {
  const now = options.now ?? Date.now()
  const { webOrigin } = configuration(env)
  const db = drizzle(env.DB)
  const group = agentGroup(now)
  const agents = agentSelected(userId, filter)
  const wallets = walletSelected(userId, filter)
  const before = filter.before
  const [agentRows, walletRows, agentCounts, walletCounts] = await Promise.all([
    agents
      ? agentQuery(env.DB)
          .where(
            and(
              agents,
              filter.status === undefined
                ? undefined
                : sql`${group} = ${filter.status}`,
              before &&
                sql`(${transactionRequest.createdAt}, ${transactionRequest.id}, 'agent') < (${before.createdAt}, ${before.id}, ${before.kind})`,
            ),
          )
          .orderBy(
            desc(transactionRequest.createdAt),
            desc(transactionRequest.id),
          )
          .limit(filter.limit + 1)
      : [],
    wallets
      ? db
          .select()
          .from(walletTransfer)
          .where(
            and(
              wallets,
              filter.status === undefined
                ? undefined
                : WALLET_STATUS[filter.status],
              before &&
                sql`(${walletTransfer.createdAt}, ${walletTransfer.id}, case ${walletTransfer.direction} when 'in' then 'deposit' else 'withdrawal' end) < (${before.createdAt}, ${before.id}, ${before.kind})`,
            ),
          )
          .orderBy(desc(walletTransfer.createdAt), desc(walletTransfer.id))
          .limit(filter.limit + 1)
      : [],
    agents
      ? db
          .select({ group, count: sql<number>`count(*)` })
          .from(transactionRequest)
          .where(agents)
          .groupBy(group)
      : [],
    wallets
      ? db
          .select({
            group: sql<TransactionStatusGroup>`${walletTransfer.status}`,
            count: sql<number>`count(*)`,
          })
          .from(walletTransfer)
          .where(wallets)
          .groupBy(walletTransfer.status)
      : [],
  ])

  const rows: TransactionActivityItem[] = [
    ...agentRows.map((found) =>
      agentItem(found, webOrigin, now, options.tools),
    ),
    ...walletRows.map(walletItem),
  ]
  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    if (a.id !== b.id) return a.id < b.id ? 1 : -1
    return a.kind === b.kind ? 0 : a.kind < b.kind ? 1 : -1
  })
  const items = rows.slice(0, filter.limit)
  const last = items.at(-1)
  const counts = { pending: 0, confirmed: 0, failed: 0, expired: 0 }
  for (const { group: key, count } of [...agentCounts, ...walletCounts])
    counts[key] += count
  return {
    items,
    nextCursor:
      rows.length > filter.limit && last
        ? `${last.createdAt}_${last.id}.${last.kind}`
        : null,
    counts,
  }
}

/**
 * One of the user's transactions, after checking the chain for a request
 * that may have moved on. The dashboard calls this when a drawer opens, so
 * list reads never touch the RPC.
 */
export async function readTransaction(
  env: TransactionExecutionEnv,
  userId: string,
  id: string,
  options: ExecutionOptions = {},
): Promise<TransactionActivityItem | null> {
  const now = options.now ?? Date.now()
  const owned = and(
    eq(transactionRequest.id, id),
    eq(transactionRequest.creatorUserId, userId),
  )
  const stored = await agentQuery(env.DB).where(owned).get()
  if (stored) {
    const link = projectTransactionLink(
      stored.row,
      stored.available === 1,
      now,
      options.tools,
    )
    if (['ready', 'submitting', 'unknown'].includes(link.status))
      await observeTransactionLink(env, id, options)
    const fresh = await agentQuery(env.DB).where(owned).get()
    return fresh
      ? agentItem(fresh, configuration(env).webOrigin, now, options.tools)
      : null
  }
  const transfers = () =>
    drizzle(env.DB)
      .select()
      .from(walletTransfer)
      .where(
        and(eq(walletTransfer.id, id), eq(walletTransfer.privyUserId, userId)),
      )
      .get()
  const transfer = await transfers()
  if (!transfer) return null
  if (transfer.status === 'pending') {
    // A withdrawal that was sent may have landed since; ask the chain once.
    try {
      const rpc = options.rpc ?? transactionRpc(env.SOLANA_RPC_URL)
      await verifyRpcNetwork(rpc, transfer.network)
      const observed = await observeSubmission(rpc, transfer.signature, {
        attempts: 1,
        intervalMs: 0,
        ...options.observation,
      })
      if (observed.status !== 'unknown')
        await settleWalletTransfer(env.DB, {
          userId,
          signature: transfer.signature,
          status: observed.status,
          slot: observed.receipt?.slot,
          now,
        })
    } catch {
      // A failing provider leaves the stored row as it is.
    }
    return walletItem((await transfers()) ?? transfer)
  }
  return walletItem(transfer)
}
