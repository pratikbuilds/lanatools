import { WorkerEntrypoint } from 'cloudflare:workers'
import { PrivyClient } from '@privy-io/node'
import { runHeliusTool } from '@lanatools/helius'
import type { D1Database } from '@cloudflare/workers-types'
import type { JupiterRequest } from '@lanatools/jupiter'
import { readJupiter } from './jupiter'
import { PayHttpError, payHttp, payKitPayer } from './payments/pay-http'
import type { PayHttpInput, PayHttpResult } from './payments/pay-http'
import { paymentConfig } from './payments/network'
import { signerStatus } from './payments/signer-setup'
import type { PaymentEnv } from './payments/network'
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
import { solanaConfig } from './solana/network'
import { runTool } from './tools/run-tool'

/** The MCP Worker's RPC surface for deleting OAuth tokens held in its KV. */
export type McpTokenRevoker = {
  revokeClient: (
    userId: string,
    clientId: string,
    grantId: string,
  ) => Promise<void>
}

export type McpEnv = PaymentEnv & {
  /** Server-managed Jupiter REST key; never exposed to MCP clients. */
  JUPITER_API_KEY?: string
  DB: D1Database
  PRIVY_APP_ID: string
  PRIVY_APP_SECRET: string
  /** Key quorum ID of the LanaTools payment signer. */
  PRIVY_PAYMENT_SIGNER_ID: string
  /** That quorum's P-256 authorization key. Never leaves this Worker. */
  PRIVY_PAYMENT_SIGNER_KEY: string
}

export type McpDashboardEnv = McpEnv & { MCP: McpTokenRevoker }

export function privyClient(env: McpEnv) {
  return new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
  })
}

export async function verifyPrivyToken(env: McpEnv, privyToken: string) {
  const { user_id: userId } = await privyClient(env)
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
  async readJupiter(
    grantId: string,
    userId: string,
    clientId: string,
    request: JupiterRequest,
  ) {
    return readJupiter(
      this.env.DB,
      { grantId, userId, clientId },
      request,
      this.env.JUPITER_API_KEY,
    )
  }

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
    toolScopes: string[],
    limitMicroUsd: number | null = null,
  ) {
    await activateGrant(
      this.env.DB,
      handle,
      { grantId, userId, clientId },
      toolScopes,
      limitMicroUsd,
    )
  }

  /**
   * Calls an endpoint for the grant's client, paying its fixed charge from
   * the user's wallet. RPC does not carry error classes, so refusals come
   * back as an agent-safe message rather than an exception.
   */
  async payHttp(
    grantId: string,
    userId: string,
    clientId: string,
    input: PayHttpInput,
  ): Promise<
    { ok: true; result: PayHttpResult } | { ok: false; error: string }
  > {
    const env = this.env
    const privy = privyClient(env)
    const config = () => paymentConfig(env)
    try {
      const result = await payHttp(
        {
          db: env.DB,
          config,
          payer: (wallet) => async (request) =>
            payKitPayer({
              privy,
              authorizationKey: env.PRIVY_PAYMENT_SIGNER_KEY,
              config: await config(),
              wallet,
            })(request),
        },
        { grantId, userId, clientId },
        input,
      )
      return { ok: true, result }
    } catch (error) {
      if (error instanceof PayHttpError)
        return { ok: false, error: error.message }
      throw error
    }
  }

  /** Generic read-only tool execution; the API independently authorizes it. */
  async runTool(
    grantId: string,
    userId: string,
    clientId: string,
    name: string,
    input: unknown,
  ) {
    return runTool(
      {
        db: this.env.DB,
        config: () => solanaConfig(this.env),
        run: runHeliusTool,
      },
      { grantId, userId, clientId },
      name,
      input,
    )
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

  /** The user's payment wallet address, or null before it is set up. */
  async walletAddress(userId: string) {
    return (await signerStatus(this.env.DB, userId)).walletAddress
  }
}
