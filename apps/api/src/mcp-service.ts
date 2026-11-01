import { WorkerEntrypoint } from 'cloudflare:workers'
import { PrivyClient } from '@privy-io/node'
import type { D1Database } from '@cloudflare/workers-types'
import { saveFeedback } from './agent-feedback'
import { PayHttpError, payHttp, payKitPayer } from './payments/pay-http'
import type { PayHttpInput, PayHttpResult } from './payments/pay-http'
import { signerStatus } from './payments/signer-setup'
import {
  activateGrant,
  authorizeGrant,
  discardConsent,
  pendingConsent,
  prepareGrant,
  recordConsent,
  revokeGrant,
} from './mcp-grants'
import type { ConsentInput, GrantIdentity } from './mcp-grants'
import {
  createTransactionRequest,
  sendTransaction,
  transactionStatus,
} from './transactions/requests'
import type { TransactionLinkEnv } from './transactions/requests'
import { paymentConfig } from './solana/network'
import { callPublicTool, callTool } from './tools/call-tool'
import type { ProviderEnv } from './tools/providers'

/** The MCP Worker's RPC surface for deleting OAuth tokens held in its KV. */
export type McpTokenRevoker = {
  revokeClient: (
    userId: string,
    clientId: string,
    grantId: string,
  ) => Promise<void>
}

export type McpEnv = ProviderEnv &
  TransactionLinkEnv & {
    DB: D1Database
    PRIVY_APP_ID: string
    PRIVY_APP_SECRET: string
    /** Key quorum ID of the LanaTools payment signer. */
    PRIVY_PAYMENT_SIGNER_ID: string
    /** That quorum's P-256 authorization key. Never leaves this Worker. */
    PRIVY_PAYMENT_SIGNER_KEY: string
    /**
     * Key quorum and key of the LanaTools transaction signer, which signs
     * embedded transactions. Optional: without them, embedded delivery is off.
     */
    PRIVY_TRANSACTION_SIGNER_ID?: string
    PRIVY_TRANSACTION_SIGNER_KEY?: string
    /**
     * SPKI verification key from the Privy dashboard. When set, access
     * tokens are checked locally instead of fetching the app JWKS.
     */
    PRIVY_JWT_VERIFICATION_KEY?: string
  }

export type McpDashboardEnv = McpEnv & { MCP: McpTokenRevoker }

/**
 * One client per isolate. Verification caches its JWKS on the client, so a
 * new client on every request downloads the key set before any other work.
 * A verification key from the Privy dashboard skips that fetch entirely.
 */
const privyClients = new Map<string, PrivyClient>()

export function privyClient(env: McpEnv) {
  const key = `${env.PRIVY_APP_ID}\0${env.PRIVY_APP_SECRET}\0${env.PRIVY_JWT_VERIFICATION_KEY ?? ''}`
  const existing = privyClients.get(key)
  if (existing) return existing
  const client = new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    ...(env.PRIVY_JWT_VERIFICATION_KEY
      ? { jwtVerificationKey: env.PRIVY_JWT_VERIFICATION_KEY }
      : {}),
  })
  privyClients.set(key, client)
  return client
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

/**
 * The MCP Worker's RPC surface. Every grant-scoped method takes the grant's
 * identity as one object and authorizes it here: the API is the boundary.
 */
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
    identity: GrantIdentity,
    toolScopes: string[],
    limitMicroUsd: number | null = null,
  ) {
    await activateGrant(
      this.env.DB,
      handle,
      identity,
      toolScopes,
      limitMicroUsd,
    )
  }

  /** Returns the account for an active grant, or null once it is revoked. */
  async whoami(identity: GrantIdentity) {
    const access = await authorizeGrant(this.env.DB, identity, null)
    return access === 'active'
      ? { userId: identity.userId, clientId: identity.clientId }
      : null
  }

  /** The user's payment wallet address, or null before it is set up. */
  async walletAddress(userId: string) {
    return (await signerStatus(this.env.DB, userId)).walletAddress
  }

  /**
   * Saves feedback from the grant's agent, or from an agent that is not logged
   * in when identity is null; false once the grant is revoked.
   */
  async sendFeedback(identity: GrantIdentity | null, feedback: string) {
    return saveFeedback(this.env.DB, identity, feedback)
  }

  // A null identity is an agent that is not logged in; it may use link and
  // local delivery only.
  async createTransactionRequest(
    identity: GrantIdentity | null,
    name: string,
    input: unknown,
  ) {
    return createTransactionRequest(this.env, identity, name, input)
  }

  async transactionStatus(identity: GrantIdentity | null, id: string) {
    return transactionStatus(this.env, identity, id)
  }

  async sendTransaction(
    identity: GrantIdentity | null,
    id: string,
    input: unknown,
  ) {
    return sendTransaction(this.env, identity, id, input)
  }

  /** Runs any provider tool, recording it in the client's activity. */
  async callTool(identity: GrantIdentity, name: string, input: unknown) {
    return callTool({ db: this.env.DB, env: this.env }, identity, name, input)
  }

  /** Runs a read tool for an agent that is not logged in, recording its use. */
  async callPublicTool(name: string, input: unknown, country?: string) {
    return callPublicTool(
      { db: this.env.DB, env: this.env },
      name,
      input,
      country,
    )
  }

  /**
   * Calls an endpoint for the grant's client, paying its fixed charge from
   * the user's wallet. RPC does not carry error classes, so refusals come
   * back as an agent-safe message rather than an exception.
   */
  async payHttp(
    identity: GrantIdentity,
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
        identity,
        input,
      )
      return { ok: true, result }
    } catch (error) {
      if (error instanceof PayHttpError)
        return { ok: false, error: error.message }
      throw error
    }
  }
}
