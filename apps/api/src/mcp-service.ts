import { WorkerEntrypoint } from 'cloudflare:workers'
import { PrivyClient } from '@privy-io/node'
import { and, eq, lt } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { mcpConsent, mcpGrant } from './db/schema'

type ConsentInput = {
  handle: string
  clientId: string
  clientName: string
  redirectUri: string
  scopes: string[]
}

type McpEnv = {
  DB: D1Database
  PRIVY_APP_ID: string
  PRIVY_APP_SECRET: string
}

export class McpAccessService extends WorkerEntrypoint<McpEnv> {
  async recordConsent(input: ConsentInput) {
    if (input.scopes.length !== 1 || input.scopes[0] !== 'account:read')
      throw new Error('Unsupported access request')
    const db = drizzle(this.env.DB)
    await db.delete(mcpConsent).where(lt(mcpConsent.expiresAt, Date.now()))
    await db.insert(mcpConsent).values({
      handle: input.handle,
      clientId: input.clientId,
      clientName: input.clientName,
      redirectUri: input.redirectUri,
      scope: input.scopes[0],
      expiresAt: Date.now() + 10 * 60_000,
    })
  }

  async discardConsent(handle: string) {
    await drizzle(this.env.DB)
      .delete(mcpConsent)
      .where(eq(mcpConsent.handle, handle))
  }

  async pendingConsent(handle: string) {
    const consent = await drizzle(this.env.DB)
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

  async verifyPrivyToken(privyToken: string) {
    const privy = new PrivyClient({
      appId: this.env.PRIVY_APP_ID,
      appSecret: this.env.PRIVY_APP_SECRET,
    })
    const { user_id: userId } = await privy
      .utils()
      .auth()
      .verifyAccessToken(privyToken)
    return userId
  }

  async grantIdForConsent(handle: string, clientId: string, userId: string) {
    const consent = await this.pendingConsent(handle)
    if (!consent || consent.clientId !== clientId)
      throw new Error('Authorization request expired')
    const grant = await drizzle(this.env.DB)
      .select({ id: mcpGrant.id })
      .from(mcpGrant)
      .where(
        and(eq(mcpGrant.privyUserId, userId), eq(mcpGrant.clientId, clientId)),
      )
      .get()
    return { grantId: grant?.id ?? crypto.randomUUID() }
  }

  async activateGrant(
    handle: string,
    clientId: string,
    userId: string,
    grantId: string,
  ) {
    const consent = await drizzle(this.env.DB)
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

    const db = drizzle(this.env.DB)
    const [[grant]] = await db.batch([
      db
        .insert(mcpGrant)
        .values({
          id: grantId,
          privyUserId: userId,
          clientId,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [mcpGrant.privyUserId, mcpGrant.clientId],
          set: { status: 'active' },
          setWhere: eq(mcpGrant.id, grantId),
        })
        .returning({ id: mcpGrant.id }),
      db.delete(mcpConsent).where(eq(mcpConsent.handle, handle)),
    ])
    if (!grant) throw new Error('MCP grant changed during authorization')
  }

  async whoami(grantId: string, userId: string, clientId: string) {
    const grant = await drizzle(this.env.DB)
      .select({ id: mcpGrant.id })
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
    return grant ? { userId, clientId } : null
  }
}
