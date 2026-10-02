import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { ACTIVITY_CHART_DAYS } from '@lanatools/contracts'
import type {
  ActivityDays,
  ActivityItem,
  ActivityPage,
  ActivityQuery,
} from '@lanatools/contracts'
import { mcpGrant, paymentActivity } from '../db/schema'

/** Calls fetched per request; the dashboard asks for the next page on scroll. */
export const ACTIVITY_PAGE_SIZE = 50

const DAY_MS = 86_400_000

type Outcome = ActivityItem['outcome']

// The dashboard lists calls that have ended. A payment still in progress, or
// one that was started and released, is bookkeeping for the client's limit.
const LISTED: Outcome[] = ['paid', 'free', 'refused', 'failed']

function isOutcome(status: string): status is Outcome {
  return (LISTED as string[]).includes(status)
}

export type ActivityCursor = { createdAt: number; id: string }

/** Reads a `before` cursor, or null if it is not one `listActivity` issued. */
export function parseActivityCursor(value: string): ActivityCursor | null {
  const match = /^(\d{1,15})_([\w-]{1,64})$/.exec(value)
  if (!match?.[1] || !match[2]) return null
  return { createdAt: Number(match[1]), id: match[2] }
}

/**
 * One page of a user's calls, newest first, with totals over every call the
 * filters select. Rows are matched on the user alone, so a client ID
 * belonging to someone else selects nothing.
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
  const selected = and(
    eq(paymentActivity.privyUserId, userId),
    inArray(paymentActivity.status, filter.outcome ? [filter.outcome] : LISTED),
    filter.clientId === undefined
      ? undefined
      : eq(paymentActivity.clientId, filter.clientId),
  )
  const [rows, [totals]] = await Promise.all([
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
      // A user has one grant row per client, kept when the client is
      // disconnected, so its calls keep their name.
      .leftJoin(
        mcpGrant,
        and(
          eq(mcpGrant.privyUserId, paymentActivity.privyUserId),
          eq(mcpGrant.clientId, paymentActivity.clientId),
        ),
      )
      .where(
        and(
          selected,
          filter.before &&
            sql`(${paymentActivity.createdAt}, ${paymentActivity.id}) < (${filter.before.createdAt}, ${filter.before.id})`,
        ),
      )
      .orderBy(desc(paymentActivity.createdAt), desc(paymentActivity.id))
      // One extra row tells whether an older page exists.
      .limit(filter.limit + 1),
    db
      .select({
        calls: sql<number>`count(*)`,
        spentMicroUsd: sql<number>`coalesce(sum(${paymentActivity.settledAtomic}), 0)`,
      })
      .from(paymentActivity)
      .where(selected),
  ])
  if (!totals) throw new Error('Activity totals returned no row')

  const page = rows.slice(0, filter.limit)
  const last = page.at(-1)
  return {
    items: page.flatMap((row) =>
      isOutcome(row.status)
        ? [
            {
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
    nextCursor:
      rows.length > filter.limit && last
        ? `${last.createdAt}_${last.id}`
        : null,
    totals,
  }
}

/**
 * Calls and spend per UTC day over the charted window, which ends today.
 * Days without a call are left out.
 */
export async function activityDays(
  database: D1Database,
  userId: string,
  now = Date.now(),
): Promise<ActivityDays['days']> {
  const today = now - (now % DAY_MS)
  const day = sql<string>`date(${paymentActivity.createdAt} / 1000, 'unixepoch')`
  return drizzle(database)
    .select({
      day,
      calls: sql<number>`count(*)`,
      spentMicroUsd: sql<number>`coalesce(sum(${paymentActivity.settledAtomic}), 0)`,
    })
    .from(paymentActivity)
    .where(
      and(
        eq(paymentActivity.privyUserId, userId),
        inArray(paymentActivity.status, LISTED),
        gte(
          paymentActivity.createdAt,
          today - (ACTIVITY_CHART_DAYS - 1) * DAY_MS,
        ),
      ),
    )
    .groupBy(day)
    .orderBy(day)
}
