import {
  TRANSACTION_STATUS_GROUPS,
  TransactionActivityItem,
  TransactionsPage,
  TransactionsSync,
  transactionStatusGroup,
} from '@lanatools/contracts'
import type {
  AgentTransactionItem,
  TransactionDelivery,
  TransactionStatusGroup,
  TransactionsQuery,
} from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'
import { formatUnits } from './solana'

export type TransactionKind = NonNullable<TransactionsQuery['kind']>

/** Which transactions to list; `undefined` leaves that filter off. */
export type TransactionsFilter = {
  status: TransactionStatusGroup | undefined
  kind: TransactionKind | undefined
  client: string | undefined
  delivery: TransactionDelivery | undefined
  address: string | undefined
}

export const EMPTY_FILTER: TransactionsFilter = {
  status: undefined,
  kind: undefined,
  client: undefined,
  delivery: undefined,
  address: undefined,
}

export const STATUS_GROUPS = TRANSACTION_STATUS_GROUPS
export const STATUS_LABELS: Record<TransactionStatusGroup, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  failed: 'Failed',
  expired: 'Expired',
}
export const KINDS: TransactionKind[] = ['agent', 'withdrawal', 'deposit']
export const KIND_LABELS: Record<TransactionKind, string> = {
  agent: 'Agent',
  withdrawal: 'Withdrawals',
  deposit: 'Deposits',
}
export const DELIVERIES: TransactionDelivery[] = ['link', 'local', 'embedded']
export const DELIVERY_LABELS: Record<TransactionDelivery, string> = {
  link: 'Link',
  local: 'Local',
  embedded: 'Embedded',
}

/** One sentence on what a raw status means for the person reading it. */
export const STATUS_NOTES: Record<string, string> = {
  open: 'Waiting for someone to open the review link and sign.',
  preparing: 'Being built for the wallet that will sign it.',
  ready: "Built and waiting for the agent's wallet to sign it.",
  submitting: 'Sent. Waiting for the chain to confirm it.',
  unknown: 'Sent, but the chain has not confirmed or rejected it yet.',
  confirmed: 'Confirmed on chain.',
  failed: 'The chain rejected this transaction. Nothing moved.',
  expired: 'The review link expired before anyone signed.',
  transaction_expired:
    'The built transaction expired before it was signed. The agent can retry with the same key.',
  unavailable:
    'The client was disconnected, or LanaTools access was removed, before this was signed.',
}

export function statusGroup(item: TransactionActivityItem) {
  return item.kind === 'agent'
    ? transactionStatusGroup(item.status)
    : item.status
}

/** Reads a filter out of the address bar, dropping anything unrecognised. */
export function parseTransactionsSearch(
  search: Record<string, unknown>,
): TransactionsFilter {
  return {
    status: STATUS_GROUPS.find((status) => status === search.status),
    kind: KINDS.find((kind) => kind === search.kind),
    client: typeof search.client === 'string' ? search.client : undefined,
    delivery: DELIVERIES.find((delivery) => delivery === search.delivery),
    address:
      typeof search.address === 'string' && search.address.length <= 64
        ? search.address
        : undefined,
  }
}

export async function listTransactions(
  getAccessToken: GetAccessToken,
  query: TransactionsFilter & { before: string | undefined },
) {
  const params = new URLSearchParams()
  for (const key of [
    'status',
    'kind',
    'client',
    'delivery',
    'address',
    'before',
  ] as const)
    if (query[key]) params.set(key, query[key])
  const response = await fetch(`/api/transactions?${params}`, {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not load transactions.')
  return TransactionsPage.assert(await response.json())
}

/** Asks the API to bring deposits and settled withdrawals in from the chain. */
export async function syncTransactions(getAccessToken: GetAccessToken) {
  const response = await fetch('/api/transactions/sync', {
    method: 'POST',
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not check the chain for deposits.')
  return TransactionsSync.assert(await response.json())
}

/** One transaction, after the API has checked the chain for it. */
export async function getTransaction(
  getAccessToken: GetAccessToken,
  id: string,
) {
  const response = await fetch(`/api/transactions/${encodeURIComponent(id)}`, {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not refresh this transaction.')
  return TransactionActivityItem.assert(await response.json())
}

/** The title a row shows: the review's for an agent, the asset's for the wallet. */
export function transactionTitle(item: TransactionActivityItem) {
  if (item.kind === 'agent') return item.review.title
  return `${item.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} ${item.symbol ?? shortAddress(item.mint)}`
}

/** `7xKX…gAsU`, for a row; the drawer shows whole addresses. */
export function shortAddress(address: string) {
  return address.length > 12
    ? `${address.slice(0, 4)}…${address.slice(-4)}`
    : address
}

function field(item: AgentTransactionItem, labels: string[]) {
  for (const label of labels) {
    const found = item.review.fields.find((each) => each.label === label)
    if (found) return found.value
  }
  return null
}

/**
 * What a transaction moves, from the wallet's side, as the review states it:
 * `out` is what it pays, `in` what comes back. A swap has both.
 */
export function transactionAmounts(item: TransactionActivityItem): {
  out: string | null
  in: string | null
} {
  if (item.kind !== 'agent') {
    const amount =
      `${formatUnits(BigInt(item.amountAtomic), item.decimals, { maxFraction: item.decimals })} ${item.symbol ?? ''}`.trim()
    return item.kind === 'deposit'
      ? { out: null, in: amount }
      : { out: amount, in: null }
  }
  return {
    out: field(item, ['You pay', 'Amount']),
    in: field(item, ['Estimated receive', 'You receive']),
  }
}

/** The second line of a row: with whom, or what a swap brings back. */
export function transactionDetail(item: TransactionActivityItem) {
  if (statusGroup(item) === 'failed')
    return { text: 'Rejected by the chain. Nothing moved.', bad: true }
  if (item.kind === 'deposit')
    return { text: `From ${shortAddress(item.counterparty)}`, bad: false }
  if (item.kind === 'withdrawal')
    return { text: `To ${shortAddress(item.counterparty)}`, bad: false }
  if (item.counterparty)
    return { text: `To ${shortAddress(item.counterparty)}`, bad: false }
  const received = transactionAmounts(item).in
  if (received)
    return {
      text:
        statusGroup(item) === 'confirmed'
          ? `≈ ${received} received`
          : `${received} expected`,
      bad: false,
    }
  return null
}
