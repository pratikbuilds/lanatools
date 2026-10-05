import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { grantScopes, isClientLimit } from '@lanatools/contracts'
import type { McpClient, McpScope } from '@lanatools/contracts'
import {
  mcpConsent,
  mcpGrant,
  paymentActivity,
  toolActivity,
} from './db/schema'

export type ConsentInput = {
  handle: string
  clientId: string
  clientName: string
  redirectUri: string
}

export type GrantIdentity = {
  grantId: string
  userId: string
  clientId: string
}

// Tool calls record use at most this often, so each call is not a D1 write.
const LAST_USED_INTERVAL = 5 * 60_000

export function scopeList(scope: string) {
  return scope.split(' ')
}

/**
 * Checks a spending limit the user approved. A payments grant needs one;
 * any other grant must not carry one.
 */
function approvedLimit(scope: string, limitMicroUsd: number | null) {
  if (!scopeList(scope).includes('payments:pay')) {
    if (limitMicroUsd !== null) throw new Error('Unexpected spending limit')
    return 0
  }
  if (!isClientLimit(limitMicroUsd))
    throw new Error('Set a spending limit to allow payments')
  return limitMicroUsd
}

export async function recordConsent(
  database: D1Database,
  input: ConsentInput,
  now = Date.now(),
) {
  const db = drizzle(database)
  await db.delete(mcpConsent).where(lt(mcpConsent.expiresAt, now))
  await db.insert(mcpConsent).values({
    handle: input.handle,
    clientId: input.clientId,
    clientName: input.clientName,
    redirectUri: input.redirectUri,
    expiresAt: now + 10 * 60_000,
  })
}

export async function discardConsent(database: D1Database, handle: string) {
  await drizzle(database)
    .delete(mcpConsent)
    .where(eq(mcpConsent.handle, handle))
}

export async function pendingConsent(database: D1Database, handle: string) {
  const consent = await drizzle(database)
    .select()
    .from(mcpConsent)
    .where(eq(mcpConsent.handle, handle))
    .get()
  if (!consent || consent.expiresAt < Date.now()) return null
  return {
    clientName: consent.clientName,
    clientId: consent.clientId,
    redirectUri: consent.redirectUri,
  }
}

export async function prepareGrant(
  database: D1Database,
  handle: string,
  clientId: string,
  userId: string,
) {
  const consent = await pendingConsent(database, handle)
  if (!consent || consent.clientId !== clientId)
    throw new Error('Authorization request expired')
  const db = drizzle(database)
  const now = Date.now()
  // A revoked grant gets a new ID, so tokens issued before the revocation
  // never become valid again when the user reconnects the same client.
  await db
    .insert(mcpGrant)
    .values({
      id: crypto.randomUUID(),
      privyUserId: userId,
      clientId,
      status: 'pending',
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [mcpGrant.privyUserId, mcpGrant.clientId],
      set: {
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: now,
        activatedAt: null,
        revokedAt: null,
        lastUsedAt: null,
      },
      setWhere: eq(mcpGrant.status, 'revoked'),
    })
  const grant = await db
    .select({ id: mcpGrant.id })
    .from(mcpGrant)
    .where(
      and(eq(mcpGrant.privyUserId, userId), eq(mcpGrant.clientId, clientId)),
    )
    .get()
  if (!grant) throw new Error('Could not prepare MCP grant')
  return { grantId: grant.id }
}

/** Activates the grant with the tool families the user chose at consent. */
export async function activateGrant(
  database: D1Database,
  handle: string,
  { grantId, userId, clientId }: GrantIdentity,
  toolScopes: readonly string[],
  limitMicroUsd: number | null = null,
) {
  const db = drizzle(database)
  const consent = await db
    .select()
    .from(mcpConsent)
    .where(
      and(eq(mcpConsent.handle, handle), eq(mcpConsent.clientId, clientId)),
    )
    .get()
  if (!consent || consent.expiresAt < Date.now())
    throw new Error('Authorization request expired')
  const scopes = grantScopes(toolScopes)
  if (!scopes) throw new Error('Unsupported tool access')
  const scope = scopes.join(' ')
  const limit = approvedLimit(scope, limitMicroUsd)

  const now = Date.now()
  const [[grant]] = await db.batch([
    db
      .insert(mcpGrant)
      .values({
        id: grantId,
        privyUserId: userId,
        clientId,
        scope,
        limitMicroUsd: limit,
        clientName: consent.clientName,
        redirectUri: consent.redirectUri,
        createdAt: now,
        activatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpGrant.privyUserId, mcpGrant.clientId],
        set: {
          status: 'active',
          scope,
          limitMicroUsd: limit,
          clientName: consent.clientName,
          redirectUri: consent.redirectUri,
          activatedAt: now,
        },
        // A disconnect during this approval keeps the grant revoked.
        setWhere: sql`${mcpGrant.id} = ${grantId} and ${mcpGrant.status} != 'revoked'`,
      })
      .returning({ id: mcpGrant.id }),
    db.delete(mcpConsent).where(eq(mcpConsent.handle, handle)),
  ])
  if (!grant) throw new Error('MCP grant changed during authorization')
}

/** Whether the grant is active, recording the use when it is. */
export async function useActiveGrant(
  database: D1Database,
  { grantId, userId, clientId }: GrantIdentity,
  now = Date.now(),
  requiredScope?: McpScope,
) {
  const db = drizzle(database)
  const grant = await db
    .select({ lastUsedAt: mcpGrant.lastUsedAt, scope: mcpGrant.scope })
    .from(mcpGrant)
    .where(
      and(
        eq(mcpGrant.id, grantId),
        eq(mcpGrant.privyUserId, userId),
        eq(mcpGrant.clientId, clientId),
        eq(mcpGrant.status, 'active'),
      ),
    )
    .get()
  if (!grant) return false
  if (requiredScope && !scopeList(grant.scope).includes(requiredScope))
    return false
  if (!grant.lastUsedAt || now - grant.lastUsedAt > LAST_USED_INTERVAL) {
    // Last use is bookkeeping; failing to record it must not deny access.
    try {
      await db
        .update(mcpGrant)
        .set({ lastUsedAt: now })
        .where(eq(mcpGrant.id, grantId))
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'Could not record MCP grant use',
          grantId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
  return true
}

export async function listClients(
  database: D1Database,
  userId: string,
): Promise<McpClient[]> {
  const db = drizzle(database)
  // Spending belongs to the user and client, not the grant row, so a
  // reconnected client keeps what it already spent.
  const totals = db
    .select({
      clientId: paymentActivity.clientId,
      spent: sql<
        number | null
      >`coalesce(sum(case when ${paymentActivity.status} = 'paid' then ${paymentActivity.settledAtomic} else 0 end), 0)`.as(
        'spent',
      ),
      reserved: sql<
        number | null
      >`coalesce(sum(case when ${paymentActivity.status} in ('reserved', 'uncertain') then ${paymentActivity.reservedAtomic} else 0 end), 0)`.as(
        'reserved',
      ),
    })
    .from(paymentActivity)
    .where(eq(paymentActivity.privyUserId, userId))
    .groupBy(paymentActivity.clientId)
    .as('totals')
  // Aggregate each ledger before joining to avoid multiplying payment spend
  // by the number of tool calls. Credit history also survives reconnects.
  const toolTotals = db
    .select({
      clientId: toolActivity.clientId,
      estimatedCredits: sql<
        number | null
      >`coalesce(sum(${toolActivity.credits}), 0)`.as('estimated_credits'),
    })
    .from(toolActivity)
    .where(eq(toolActivity.privyUserId, userId))
    .groupBy(toolActivity.clientId)
    .as('tool_totals')
  const rows = await db
    .select({
      grantId: mcpGrant.id,
      clientId: mcpGrant.clientId,
      clientName: mcpGrant.clientName,
      redirectUri: mcpGrant.redirectUri,
      scope: mcpGrant.scope,
      limitMicroUsd: mcpGrant.limitMicroUsd,
      spent: totals.spent,
      reserved: totals.reserved,
      estimatedCredits: toolTotals.estimatedCredits,
      createdAt: mcpGrant.createdAt,
      activatedAt: mcpGrant.activatedAt,
      lastUsedAt: mcpGrant.lastUsedAt,
    })
    .from(mcpGrant)
    .leftJoin(totals, eq(totals.clientId, mcpGrant.clientId))
    .leftJoin(toolTotals, eq(toolTotals.clientId, mcpGrant.clientId))
    .where(and(eq(mcpGrant.privyUserId, userId), eq(mcpGrant.status, 'active')))
    .orderBy(desc(mcpGrant.createdAt))
  return rows.map((row) => ({
    grantId: row.grantId,
    clientId: row.clientId,
    clientName: row.clientName,
    redirectHost: row.redirectUri ? new URL(row.redirectUri).host : null,
    scopes: scopeList(row.scope),
    connectedAt: row.activatedAt ?? row.createdAt,
    lastUsedAt: row.lastUsedAt,
    limitMicroUsd: row.limitMicroUsd,
    spentMicroUsd: row.spent ?? 0,
    reservedMicroUsd: row.reserved ?? 0,
    estimatedCredits: row.estimatedCredits ?? 0,
  }))
}

/**
 * Changes an active payments grant's limit. A limit below what the client
 * already spent blocks further payments; it does not erase history.
 */
export async function setClientLimit(
  database: D1Database,
  userId: string,
  grantId: string,
  limitMicroUsd: number,
) {
  if (!isClientLimit(limitMicroUsd)) throw new Error('Invalid spending limit')
  const [grant] = await drizzle(database)
    .update(mcpGrant)
    .set({ limitMicroUsd })
    .where(
      and(
        eq(mcpGrant.id, grantId),
        eq(mcpGrant.privyUserId, userId),
        eq(mcpGrant.status, 'active'),
        sql`(' ' || ${mcpGrant.scope} || ' ') like '% payments:pay %'`,
      ),
    )
    .returning({ id: mcpGrant.id })
  return !!grant
}

/** Revokes the user's active grant; returns its client, or null if none. */
export async function revokeGrant(
  database: D1Database,
  userId: string,
  grantId: string,
  now = Date.now(),
) {
  const [grant] = await drizzle(database)
    .update(mcpGrant)
    .set({ status: 'revoked', revokedAt: now })
    .where(
      and(
        eq(mcpGrant.id, grantId),
        eq(mcpGrant.privyUserId, userId),
        eq(mcpGrant.status, 'active'),
      ),
    )
    .returning({ clientId: mcpGrant.clientId })
  return grant?.clientId ?? null
}
