import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type { runHeliusTool } from '@lanatools/helius'
import { mcpGrant, toolActivity } from '../db/schema'
import type { GrantIdentity } from '../mcp-grants'
import type { SolanaConfig, SolanaNetwork } from '../solana/network'

type ProviderOutcome = Awaited<ReturnType<typeof runHeliusTool>>
type ProviderErrorCode = Extract<
  ProviderOutcome,
  { ok: false }
>['error']['code']
export type ToolErrorCode =
  | ProviderErrorCode
  | 'unauthorized'
  | 'insufficient_scope'
  | 'network_unavailable'

export type ToolOutcome =
  | { ok: true; result: Record<string, unknown> }
  | {
      ok: false
      error: { code: ToolErrorCode; message: string }
    }

export type RunToolDeps = {
  db: D1Database
  config: () => Promise<SolanaConfig>
  run: typeof runHeliusTool
  now?: () => number
}

const MESSAGES: Record<ToolErrorCode, string> = {
  unauthorized: 'This client is not connected. Reconnect it in LanaTools.',
  insufficient_scope:
    'This client does not have Helius access. Reconnect it and allow Helius on the consent screen.',
  network_unavailable:
    'The Solana network configuration is unavailable. Try again later.',
  invalid_input: 'The tool name or input is invalid. Check the tool schema.',
  rate_limited: 'The provider is rate limited. Try again later.',
  timeout: 'The provider request timed out. Try again later.',
  plan_required: 'This tool needs a different provider plan.',
  upstream_error:
    'The provider request could not be completed. Try again later.',
}

function failed(code: ToolErrorCode): ToolOutcome {
  return { ok: false, error: { code, message: MESSAGES[code] } }
}

/**
 * The API is the authorization boundary: do not rely on the MCP Worker's
 * prior checks. Unauthenticated or out-of-scope requests cannot create ledger
 * rows attributed to a caller-supplied user. Every authorized invocation makes
 * exactly one ledger insert attempt, including validation and network failures.
 * No request inputs, response bodies, provider URLs or raw exceptions are saved.
 */
export async function runTool(
  deps: RunToolDeps,
  identity: GrantIdentity,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const db = drizzle(deps.db)
  let grant: { scope: string; lastUsedAt: number | null } | undefined
  try {
    grant = await db
      .select({ scope: mcpGrant.scope, lastUsedAt: mcpGrant.lastUsedAt })
      .from(mcpGrant)
      .where(
        and(
          eq(mcpGrant.id, identity.grantId),
          eq(mcpGrant.privyUserId, identity.userId),
          eq(mcpGrant.clientId, identity.clientId),
          eq(mcpGrant.status, 'active'),
        ),
      )
      .get()
  } catch {
    // A database failure cannot establish permission. Fail closed, safely.
    return failed('upstream_error')
  }
  if (!grant) return failed('unauthorized')
  if (!grant.scope.split(' ').includes('helius:read'))
    return failed('insufficient_scope')

  if (!grant.lastUsedAt || startedAt - grant.lastUsedAt > 5 * 60_000) {
    try {
      await db
        .update(mcpGrant)
        .set({ lastUsedAt: startedAt })
        .where(eq(mcpGrant.id, identity.grantId))
    } catch {
      console.error('Could not record MCP tool grant use')
    }
  }

  let network: SolanaNetwork['name'] | null = null
  let credits = 0
  let outcome: ToolOutcome = failed('network_unavailable')
  // Names are metadata, not an alternate channel for storing arbitrary input.
  const validName =
    typeof name === 'string' && /^[a-zA-Z][\w-]{0,127}$/.test(name)
  if (!validName) outcome = failed('invalid_input')
  else {
    let config: SolanaConfig | undefined
    try {
      config = await deps.config()
      network = config.network.name
    } catch {
      outcome = failed('network_unavailable')
    }
    if (config) {
      try {
        const response = await deps.run(name, input, { rpcUrl: config.rpcUrl })
        credits =
          Number.isSafeInteger(response.credits) && response.credits >= 0
            ? response.credits
            : 0
        if (response.ok) outcome = { ok: true, result: response.result }
        else {
          // Never forward an upstream message: it may echo credentials or input.
          const code = response.error.code
          outcome = failed(
            Object.hasOwn(MESSAGES, code) ? code : 'upstream_error',
          )
        }
      } catch {
        outcome = failed('upstream_error')
      }
    }
  }

  try {
    await db.insert(toolActivity).values({
      id: crypto.randomUUID(),
      privyUserId: identity.userId,
      clientId: identity.clientId,
      grantId: identity.grantId,
      provider: 'helius',
      tool: validName ? name : 'invalid_tool',
      network,
      status: outcome.ok ? 'ok' : 'failed',
      credits,
      errorCode: outcome.ok ? null : outcome.error.code,
      durationMs: Math.max(0, now() - startedAt),
      createdAt: startedAt,
    })
  } catch {
    // D1 may include bound values in its errors. Log only a fixed diagnostic.
    console.error('Could not record tool activity')
  }
  return outcome
}
