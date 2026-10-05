import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { isClientLimit, isMcpScope } from '@lanatools/contracts'
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
  scopes: string[]
}

export type GrantIdentity = {
  grantId: string
  userId: string
  clientId: string
}

// Tool calls record use at most this often, so each call is not a D1 write.
const LAST_USED_INTERVAL = 5 * 60_000

/** Validates requested scopes; returns them space-separated for storage. */
export function scopeString(scopes: readonly string[]) {
  if (
    scopes.length === 0 ||
    new Set(scopes).size !== scopes.length ||
    !scopes.every(isMcpScope)
  )
    throw new Error('Unsupported access request')
  return scopes.join(' ')
}

export function scopeList(scope: string) {
  return scope.split(' ')
}

/** Whether a stored, space-separated grant scope includes `required`. */
export function hasScope(scope: string, required: McpScope) {
  return scopeList(scope).includes(required)
}

/*
 * What counts as an active grant, defined once. Every grant query, including
 * the payment ledger's reservation, builds its condition from these.
 */

/** The user's active grants. */
export function activeGrantsOf(userId: string) {
  return and(eq(mcpGrant.privyUserId, userId), eq(mcpGrant.status, 'active'))
}

/** One of the user's active grants, for dashboard actions. */
export function activeGrantOwnedBy(userId: string, grantId: string) {
  return and(eq(mcpGrant.id, grantId), activeGrantsOf(userId))
}

/** The active grant an MCP connection names: its grant, user and client. */
export function activeGrantFor({ grantId, userId, clientId }: GrantIdentity) {
  return and(
    activeGrantOwnedBy(userId, grantId),
    eq(mcpGrant.clientId, clientId),
  )
}

/** The grant's stored scope includes `required`. */
export function grantHasScope(required: McpScope) {
  return sql`(' ' || ${mcpGrant.scope} || ' ') like ${`% ${required} %`}`
}

/**
 * Checks a spending limit the user approved. A payments grant needs one;
 * any other grant must not carry one.
 */
function approvedLimit(scope: string, limitMicroUsd: number | null) {
  if (!hasScope(scope, 'payments:pay')) {
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
  const scope = scopeString(input.scopes)
  const db = drizzle(database)
  await db.delete(mcpConsent).where(lt(mcpConsent.expiresAt, now))
  await db.insert(mcpConsent).values({
    handle: input.handle,
    clientId: input.clientId,
    clientName: input.clientName,
    redirectUri: input.redirectUri,
    scope,
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
    scopes: scopeList(consent.scope),
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

export async function activateGrant(
  database: D1Database,
  handle: string,
  { grantId, userId, clientId }: GrantIdentity,
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
  scopeString(scopeList(consent.scope))
  const limit = approvedLimit(consent.scope, limitMicroUsd)

  const now = Date.now()
  const [[grant]] = await db.batch([
    db
      .insert(mcpGrant)
      .values({
        id: grantId,
        privyUserId: userId,
        clientId,
        scope: consent.scope,
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
          scope: consent.scope,
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

/** Why a grant may or may not be used. */
export type GrantAccess = 'active' | 'revoked' | 'insufficient_scope'

/**
 * The one check that a grant may be used: it is active, belongs to this user
 * and client, and includes `requiredScope` (null allows any active grant).
 * Records use when allowed. A database failure throws, so callers fail closed.
 */
export async function authorizeGrant(
  database: D1Database,
  identity: GrantIdentity,
  requiredScope: McpScope | null,
  now = Date.now(),
): Promise<GrantAccess> {
  const db = drizzle(database)
  const grant = await db
    .select({ lastUsedAt: mcpGrant.lastUsedAt, scope: mcpGrant.scope })
    .from(mcpGrant)
    .where(activeGrantFor(identity))
    .get()
  if (!grant) return 'revoked'
  if (requiredScope && !hasScope(grant.scope, requiredScope))
    return 'insufficient_scope'
  if (!grant.lastUsedAt || now - grant.lastUsedAt > LAST_USED_INTERVAL) {
    // Last use is bookkeeping; failing to record it must not deny access.
    try {
      await db
        .update(mcpGrant)
        .set({ lastUsedAt: now })
        .where(eq(mcpGrant.id, identity.grantId))
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'Could not record MCP grant use',
          grantId: identity.grantId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }
  return 'active'
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
    .where(activeGrantsOf(userId))
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
      and(activeGrantOwnedBy(userId, grantId), grantHasScope('payments:pay')),
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
    .where(activeGrantOwnedBy(userId, grantId))
    .returning({ clientId: mcpGrant.clientId })
  return grant?.clientId ?? null
}
