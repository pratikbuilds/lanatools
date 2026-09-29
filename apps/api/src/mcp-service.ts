import { WorkerEntrypoint } from 'cloudflare:workers'
import { PrivyClient } from '@privy-io/node'
import type { D1Database } from '@cloudflare/workers-types'
import {
  activateGrant,
  discardConsent,
  pendingConsent,
  prepareGrant,
  recordConsent,
  revokeGrant,
  useActiveGrant,
} from './mcp-grants'
import type { ConsentInput } from './mcp-grants'

/** The MCP Worker's RPC surface for deleting OAuth tokens held in its KV. */
export type McpTokenRevoker = {
  revokeClient: (
    userId: string,
    clientId: string,
    grantId: string,
  ) => Promise<void>
}

export type McpEnv = {
  DB: D1Database
  PRIVY_APP_ID: string
  PRIVY_APP_SECRET: string
}

export type McpDashboardEnv = McpEnv & { MCP: McpTokenRevoker }

export async function verifyPrivyToken(env: McpEnv, privyToken: string) {
  const privy = new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
  })
  const { user_id: userId } = await privy
    .utils()
    .auth()
    .verifyAccessToken(privyToken)
  return userId
}

/**
 * Cuts off a client. D1 is the source of truth: every tool call and token
 * refresh checks it, so access ends here even if deleting the client's OAuth
 * tokens fails. The MCP Worker also deletes them on the client's next attempt.
 */
export async function revokeClient(
  env: McpDashboardEnv,
  userId: string,
  grantId: string,
) {
  const clientId = await revokeGrant(env.DB, userId, grantId)
  if (!clientId) return false
  try {
    await env.MCP.revokeClient(userId, clientId, grantId)
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Could not delete OAuth tokens for a revoked MCP grant',
        grantId,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  return true
}

export class McpAccessService extends WorkerEntrypoint<McpEnv> {
  async recordConsent(input: ConsentInput) {
    await recordConsent(this.env.DB, input)
  }

  async discardConsent(handle: string) {
    await discardConsent(this.env.DB, handle)
  }

  async pendingConsent(handle: string) {
    return pendingConsent(this.env.DB, handle)
  }

  async verifyPrivyToken(privyToken: string) {
    return verifyPrivyToken(this.env, privyToken)
  }

  async prepareGrant(handle: string, clientId: string, userId: string) {
    return prepareGrant(this.env.DB, handle, clientId, userId)
  }

  async activateGrant(
    handle: string,
    clientId: string,
    userId: string,
    grantId: string,
  ) {
    await activateGrant(this.env.DB, handle, { grantId, userId, clientId })
  }

  /** Returns the account for an active grant, or null once it is revoked. */
  async whoami(grantId: string, userId: string, clientId: string) {
    const active = await useActiveGrant(this.env.DB, {
      grantId,
      userId,
      clientId,
    })
    return active ? { userId, clientId } : null
  }
}
