import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { ACTIVITY_CHART_DAYS } from '@lanatools/contracts'
import type {
  ActivityDays,
  ActivityItem,
  ActivityPage,
  ActivityQuery,
  PaymentActivityItem,
} from '@lanatools/contracts'
import { mcpGrant, paymentActivity, toolActivity } from '../db/schema'

/** Calls fetched per request; the dashboard asks for the next page on scroll. */
export const ACTIVITY_PAGE_SIZE = 50

const DAY_MS = 86_400_000

type PaymentOutcome = PaymentActivityItem['outcome']

// A payment still in progress is a hold on the client's limit, not a
// completed call.
const LISTED: PaymentOutcome[] = ['paid', 'free', 'refused', 'failed']

function isPaymentOutcome(status: string): status is PaymentOutcome {
  return (LISTED as string[]).includes(status)
}

export type ActivityCursor = {
  createdAt: number
  id: string
  /** Older payment-only cursors omitted the source. */
  kind?: ActivityItem['kind']
}

/** Reads current mixed-feed cursors and legacy payment-only cursors. */
export function parseActivityCursor(value: string): ActivityCursor | null {
  const match = /^(\d{1,15})_([\w-]{1,64})(?:\.(payment|tool))?$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  const cursor: ActivityCursor = {
    createdAt: Number(match[1]),
    id: match[2],
  }
  if (match[3] === 'payment' || match[3] === 'tool') cursor.kind = match[3]
  return cursor
}

/**
 * One page of completed payments and tool calls, newest first. Each ledger
 * reads at most one page plus a sentinel; merging those bounded reads yields
 * the same page as a union. The source is a final tie-breaker because IDs are
 * unique only within each ledger. Every read is scoped to the signed-in user.
 */
export async function listActivity(
  database: D1Database,
  userId: string,
  filter: {
    clientId: string | undefined
    outcome: ActivityQuery['outcome']
    before: ActivityCursor | undefined
    limit: number
  },
): Promise<ActivityPage> {
  const db = drizzle(database)
  const paymentsSelected = and(
    eq(paymentActivity.privyUserId, userId),
    filter.outcome === undefined
      ? inArray(paymentActivity.status, LISTED)
      : isPaymentOutcome(filter.outcome)
        ? eq(paymentActivity.status, filter.outcome)
        : sql`0`,
    filter.clientId === undefined
      ? undefined
      : eq(paymentActivity.clientId, filter.clientId),
  )
  const toolsSelected = and(
    eq(toolActivity.privyUserId, userId),
    filter.outcome === undefined
      ? inArray(toolActivity.status, ['ok', 'failed'])
      : filter.outcome === 'ok' || filter.outcome === 'failed'
        ? eq(toolActivity.status, filter.outcome)
        : sql`0`,
    filter.clientId === undefined
      ? undefined
      : eq(toolActivity.clientId, filter.clientId),
  )
  const before = filter.before
  const [payments, tools, [paymentTotals], [toolTotals]] = await Promise.all([
    db
      .select({
        id: paymentActivity.id,
        clientId: paymentActivity.clientId,
        clientName: mcpGrant.clientName,
        grantStatus: mcpGrant.status,
        method: paymentActivity.method,
        origin: paymentActivity.origin,
        path: paymentActivity.path,
        protocol: paymentActivity.protocol,
        status: paymentActivity.status,
        network: paymentActivity.network,
        settledAtomic: paymentActivity.settledAtomic,
        signature: paymentActivity.signature,
        httpStatus: paymentActivity.httpStatus,
        error: paymentActivity.error,
        createdAt: paymentActivity.createdAt,
      })
      .from(paymentActivity)
      // Grant names survive disconnects, while reconnects keep the history
      // attached to the same user and client rather than the old grant ID.
      .leftJoin(
        mcpGrant,
        and(
          eq(mcpGrant.privyUserId, paymentActivity.privyUserId),
          eq(mcpGrant.clientId, paymentActivity.clientId),
        ),
      )
      .where(
        and(
          paymentsSelected,
          before &&
            sql`(${paymentActivity.createdAt}, ${paymentActivity.id}, 'payment') < (${before.createdAt}, ${before.id}, ${before.kind ?? 'payment'})`,
        ),
      )
      .orderBy(desc(paymentActivity.createdAt), desc(paymentActivity.id))
      .limit(filter.limit + 1),
    db
      .select({
        id: toolActivity.id,
        clientId: toolActivity.clientId,
        clientName: mcpGrant.clientName,
        grantStatus: mcpGrant.status,
        tool: toolActivity.tool,
        provider: toolActivity.provider,
        status: toolActivity.status,
        network: toolActivity.network,
        credits: toolActivity.credits,
        errorCode: toolActivity.errorCode,
        durationMs: toolActivity.durationMs,
        createdAt: toolActivity.createdAt,
      })
      .from(toolActivity)
      .leftJoin(
        mcpGrant,
        and(
          eq(mcpGrant.privyUserId, toolActivity.privyUserId),
          eq(mcpGrant.clientId, toolActivity.clientId),
        ),
      )
      .where(
        and(
          toolsSelected,
          before &&
            sql`(${toolActivity.createdAt}, ${toolActivity.id}, 'tool') < (${before.createdAt}, ${before.id}, ${before.kind ?? 'payment'})`,
        ),
      )
      .orderBy(desc(toolActivity.createdAt), desc(toolActivity.id))
      .limit(filter.limit + 1),
    db
      .select({
        calls: sql<number>`count(*)`,
        spentMicroUsd: sql<number>`coalesce(sum(${paymentActivity.settledAtomic}), 0)`,
      })
      .from(paymentActivity)
      .where(paymentsSelected),
    db
      .select({
        calls: sql<number>`count(*)`,
        estimatedCredits: sql<number>`coalesce(sum(${toolActivity.credits}), 0)`,
      })
      .from(toolActivity)
      .where(toolsSelected),
  ])
  if (!paymentTotals || !toolTotals)
    throw new Error('Activity totals returned no row')

  const rows: ActivityItem[] = [
    ...payments.flatMap((row): PaymentActivityItem[] =>
      isPaymentOutcome(row.status)
        ? [
            {
              kind: 'payment',
              id: row.id,
              clientId: row.clientId,
              clientName: row.clientName,
              connected: row.grantStatus === 'active',
              method: row.method,
              origin: row.origin,
              path: row.path,
              protocol: row.protocol,
              outcome: row.status,
              network: row.network,
              amountMicroUsd: row.settledAtomic,
              signature: row.signature,
              httpStatus: row.httpStatus,
              reason: row.error,
              createdAt: row.createdAt,
            },
          ]
        : [],
    ),
    ...tools.map((row) => ({
      kind: 'tool' as const,
      id: row.id,
      clientId: row.clientId,
      clientName: row.clientName,
      connected: row.grantStatus === 'active',
      tool: row.tool,
      provider: row.provider,
      outcome: row.status,
      network: row.network,
      estimatedCredits: row.credits,
      durationMs: row.durationMs,
      reason: row.errorCode,
      createdAt: row.createdAt,
    })),
  ]
  rows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
    if (a.id !== b.id) return a.id < b.id ? 1 : -1
    return a.kind === b.kind ? 0 : a.kind < b.kind ? 1 : -1
  })
  const items = rows.slice(0, filter.limit)
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > filter.limit && last
        ? `${last.createdAt}_${last.id}.${last.kind}`
        : null,
    totals: {
      calls: paymentTotals.calls + toolTotals.calls,
      spentMicroUsd: paymentTotals.spentMicroUsd,
      estimatedCredits: toolTotals.estimatedCredits,
    },
  }
}

/** Calls and payment spend per UTC day over the charted window. */
export async function activityDays(
  database: D1Database,
  userId: string,
  now = Date.now(),
): Promise<ActivityDays['days']> {
  const today = now - (now % DAY_MS)
  const since = today - (ACTIVITY_CHART_DAYS - 1) * DAY_MS
  const db = drizzle(database)
  const paymentDay = sql<string>`date(${paymentActivity.createdAt} / 1000, 'unixepoch')`
  const toolDay = sql<string>`date(${toolActivity.createdAt} / 1000, 'unixepoch')`
  const [payments, tools] = await Promise.all([
    db
      .select({
        day: paymentDay,
        calls: sql<number>`count(*)`,
        spentMicroUsd: sql<number>`coalesce(sum(${paymentActivity.settledAtomic}), 0)`,
      })
      .from(paymentActivity)
      .where(
        and(
          eq(paymentActivity.privyUserId, userId),
          inArray(paymentActivity.status, LISTED),
          gte(paymentActivity.createdAt, since),
        ),
      )
      .groupBy(paymentDay),
    db
      .select({
        day: toolDay,
        calls: sql<number>`count(*)`,
      })
      .from(toolActivity)
      .where(
        and(
          eq(toolActivity.privyUserId, userId),
          inArray(toolActivity.status, ['ok', 'failed']),
          gte(toolActivity.createdAt, since),
        ),
      )
      .groupBy(toolDay),
  ])
  const days = new Map(payments.map((day) => [day.day, day]))
  for (const tool of tools) {
    const day = days.get(tool.day)
    if (day) day.calls += tool.calls
    else days.set(tool.day, { ...tool, spentMicroUsd: 0 })
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day))
}
