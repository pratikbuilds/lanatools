import { ActivityDays, ActivityPage } from '@lanatools/contracts'
import type { ActivityItem, PaymentActivityItem } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

export type ActivityOutcome = ActivityItem['outcome']
/** Which calls to list; `undefined` leaves that filter off. */
export type ActivityFilter = {
  client: string | undefined
  outcome: ActivityOutcome | undefined
}

export const ACTIVITY_OUTCOMES: Array<ActivityOutcome> = [
  'ok',
  'paid',
  'free',
  'refused',
  'failed',
]

export const OUTCOME_LABELS: Record<ActivityOutcome, string> = {
  ok: 'Succeeded',
  paid: 'Paid',
  free: 'Free',
  refused: 'Refused',
  failed: 'Failed',
}

export async function listActivity(
  getAccessToken: GetAccessToken,
  query: ActivityFilter & { before: string | undefined },
) {
  const params = new URLSearchParams()
  if (query.client) params.set('client', query.client)
  if (query.outcome) params.set('outcome', query.outcome)
  if (query.before) params.set('before', query.before)
  const response = await fetch(`/api/activity?${params}`, {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not load activity.')
  return ActivityPage.assert(await response.json())
}

export async function listActivityDays(getAccessToken: GetAccessToken) {
  const response = await fetch('/api/activity/days', {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not load activity.')
  return ActivityDays.assert(await response.json()).days
}

const TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

/** A time of day such as "2:31 PM", in the viewer's time zone. */
export function formatTime(timestamp: number) {
  return TIME.format(timestamp)
}

/** "Today", "Yesterday", or the date, in the viewer's time zone. */
export function dayLabel(timestamp: number, now = Date.now()) {
  const day = new Date(timestamp)
  const today = new Date(now)
  const daysAgo = Math.round(
    (new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate(),
    ).getTime() -
      new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()) /
      86_400_000,
  )
  if (daysAgo === 0) return 'Today'
  if (daysAgo === 1) return 'Yesterday'
  return (
    day.getFullYear() === today.getFullYear() ? DAY : DAY_WITH_YEAR
  ).format(day)
}

/** The host a call went to, without its scheme. */
export function callHost(item: Pick<PaymentActivityItem, 'origin'>) {
  return item.origin.replace(/^https?:\/\//, '')
}

/** A human-readable estimate, kept separate from payment amounts. */
export function formatCredits(credits: number) {
  return `${credits.toLocaleString('en-US')} estimated ${credits === 1 ? 'credit' : 'credits'}`
}

export const CREDIT_ESTIMATE_NOTE =
  'Credits are estimates. Helius does not report a per-call cost.'

export function callTitle(item: ActivityItem) {
  return item.kind === 'tool' ? item.tool : `${callHost(item)}${item.path}`
}

/**
 * Where to read a payment's transaction, or null for a network Solana
 * Explorer does not serve, such as a local sandbox.
 */
export function explorerURL(network: string | null, signature: string) {
  if (network !== 'devnet' && network !== 'mainnet') return null
  const cluster = network === 'devnet' ? '?cluster=devnet' : ''
  return `https://explorer.solana.com/tx/${signature}${cluster}`
}
