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
}

type McpEnv = {
  DB: D1Database
  PRIVY_APP_ID: string
  PRIVY_APP_SECRET: string
}

export class McpAccessService extends WorkerEntrypoint<McpEnv> {
  async recordConsent(input: ConsentInput) {
    const db = drizzle(this.env.DB)
    await db.delete(mcpConsent).where(lt(mcpConsent.expiresAt, Date.now()))
    await db.insert(mcpConsent).values({
      ...input,
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
      redirectUri: consent.redirectUri,
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

  async activateGrant(handle: string, clientId: string, userId: string) {
    const consent = await drizzle(this.env.DB)
      .select()
      .from(mcpConsent)
      .where(
        and(eq(mcpConsent.handle, handle), eq(mcpConsent.clientId, clientId)),
      )
      .get()
    if (!consent || consent.expiresAt < Date.now())
      throw new Error('Authorization request expired')

    const db = drizzle(this.env.DB)
    const [grant] = await db
      .insert(mcpGrant)
      .values({
        id: crypto.randomUUID(),
        privyUserId: userId,
        clientId,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: [mcpGrant.privyUserId, mcpGrant.clientId],
        set: { status: 'active' },
      })
      .returning({ id: mcpGrant.id })
    await db.delete(mcpConsent).where(eq(mcpConsent.handle, handle))
    if (!grant) throw new Error('Could not create MCP grant')
    return { grantId: grant.id, userId }
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
