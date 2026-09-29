import { and, desc, eq, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type { McpClient } from '@lanatools/contracts'
import { mcpClient, mcpConsent, mcpGrant } from './db/schema'

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

export async function recordConsent(
  database: D1Database,
  input: ConsentInput,
  now = Date.now(),
) {
  if (input.scopes.length !== 1 || input.scopes[0] !== 'account:read')
    throw new Error('Unsupported access request')
  const db = drizzle(database)
  await db.delete(mcpConsent).where(lt(mcpConsent.expiresAt, now))
  await db.batch([
    db.insert(mcpConsent).values({
      handle: input.handle,
      clientId: input.clientId,
      clientName: input.clientName,
      redirectUri: input.redirectUri,
      scope: input.scopes[0],
      expiresAt: now + 10 * 60_000,
    }),
    db
      .insert(mcpClient)
      .values({
        clientId: input.clientId,
        clientName: input.clientName,
        redirectUri: input.redirectUri,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: mcpClient.clientId,
        set: {
          clientName: input.clientName,
          redirectUri: input.redirectUri,
          updatedAt: now,
        },
      }),
  ])
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
    scopes: [consent.scope],
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
) {
  const db = drizzle(database)
  const consent = await db
    .select()
    .from(mcpConsent)
    .where(
      and(eq(mcpConsent.handle, handle), eq(mcpConsent.clientId, clientId)),
    )
    .get()
  if (
    !consent ||
    consent.expiresAt < Date.now() ||
    consent.scope !== 'account:read'
  )
    throw new Error('Authorization request expired')

  const now = Date.now()
  const [[grant]] = await db.batch([
    db
      .insert(mcpGrant)
      .values({
        id: grantId,
        privyUserId: userId,
        clientId,
        scope: consent.scope,
        createdAt: now,
        activatedAt: now,
      })
      .onConflictDoUpdate({
        target: [mcpGrant.privyUserId, mcpGrant.clientId],
        set: { status: 'active', scope: consent.scope, activatedAt: now },
        setWhere: eq(mcpGrant.id, grantId),
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
) {
  const db = drizzle(database)
  const grant = await db
    .select({ lastUsedAt: mcpGrant.lastUsedAt })
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
  if (!grant.lastUsedAt || now - grant.lastUsedAt > LAST_USED_INTERVAL)
    await db
      .update(mcpGrant)
      .set({ lastUsedAt: now })
      .where(eq(mcpGrant.id, grantId))
  return true
}

export async function listClients(
  database: D1Database,
  userId: string,
): Promise<McpClient[]> {
  const rows = await drizzle(database)
    .select({
      grantId: mcpGrant.id,
      clientId: mcpGrant.clientId,
      clientName: mcpClient.clientName,
      redirectUri: mcpClient.redirectUri,
      scope: mcpGrant.scope,
      createdAt: mcpGrant.createdAt,
      activatedAt: mcpGrant.activatedAt,
      lastUsedAt: mcpGrant.lastUsedAt,
    })
    .from(mcpGrant)
    .leftJoin(mcpClient, eq(mcpClient.clientId, mcpGrant.clientId))
    .where(and(eq(mcpGrant.privyUserId, userId), eq(mcpGrant.status, 'active')))
    .orderBy(desc(mcpGrant.createdAt))
  return rows.map((row) => ({
    grantId: row.grantId,
    clientId: row.clientId,
    clientName: row.clientName,
    redirectHost: row.redirectUri ? new URL(row.redirectUri).host : null,
    scopes: [row.scope],
    connectedAt: row.activatedAt ?? row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }))
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
