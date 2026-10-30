import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { lookupTool } from '@lanatools/toolkit'
import type { ToolReply } from '@lanatools/toolkit'
import { toolActivity } from '../db/schema'
import { authorizeGrant } from '../mcp-grants'
import type { GrantAccess, GrantIdentity } from '../mcp-grants'
import type { SolanaNetwork } from '../solana/network'
import { NO_LOGIN } from '../transactions/requests'
import { PROVIDERS } from './providers'
import type { Fetch, HostedProvider, ProviderEnv } from './providers'

export type CallToolDeps = {
  db: D1Database
  env: ProviderEnv
  /** Defaults to every provider LanaTools serves. */
  providers?: readonly HostedProvider[]
  fetch?: Fetch
  now?: () => number
}

const ERRORS = {
  unauthorized: {
    message: 'This client is not connected. Reconnect it in LanaTools.',
    retryable: false,
  },
  invalid_input: {
    message: 'There is no tool with this name. Check the tool list.',
    retryable: false,
  },
  network_unavailable: {
    message: 'The server configuration for this tool is unavailable.',
    retryable: true,
  },
  upstream_error: {
    message: 'The tool could not be completed. Try again later.',
    retryable: true,
  },
}

function failed(code: keyof typeof ERRORS) {
  return { ok: false, error: { code, ...ERRORS[code] } } as const
}

function denied(access: Exclude<GrantAccess, 'active'>, scope: string | null) {
  if (access === 'revoked') return failed('unauthorized')
  return {
    ok: false,
    error: {
      code: 'insufficient_scope',
      message: `This client does not have ${scope} access. Reconnect it and allow it on the consent screen.`,
      retryable: false,
    },
  } as const
}

/**
 * Runs any provider tool for a grant. The API is the authorization boundary:
 * it does not rely on the MCP Worker's checks. Every authorized call makes
 * exactly one activity insert attempt, including configuration and provider
 * failures. No results, provider URLs or raw exceptions are stored, and no
 * inputs for a logged-in call.
 * Providers promise agent-safe error messages, so those pass through.
 */
export async function callTool(
  deps: CallToolDeps,
  identity: GrantIdentity,
  name: string,
  input: unknown,
): Promise<ToolReply> {
  const found = lookupTool(deps.providers ?? PROVIDERS, name)
  if (!found) return failed('invalid_input')
  const { provider } = found
  const now = deps.now ?? Date.now
  const startedAt = now()

  let access: GrantAccess
  try {
    access = await authorizeGrant(deps.db, identity, provider.scope, startedAt)
  } catch {
    // A database failure cannot establish permission. Fail closed, safely.
    return failed('upstream_error')
  }
  if (access !== 'active') return denied(access, provider.scope)

  const result = await run(deps, provider, name, input)
  await record(deps.db, result, {
    privyUserId: identity.userId,
    clientId: identity.clientId,
    grantId: identity.grantId,
    provider: provider.name,
    tool: name,
    durationMs: Math.max(0, now() - startedAt),
    createdAt: startedAt,
  })
  return result.outcome
}

/**
 * Runs a public provider tool for a caller that is not logged in. The call
 * belongs to no account, so it is recorded under NO_LOGIN, which the dashboard
 * never reads. Input and country are kept for usage analytics.
 */
export async function callPublicTool(
  deps: CallToolDeps,
  name: string,
  input: unknown,
  country?: string,
): Promise<ToolReply> {
  const found = lookupTool(deps.providers ?? PROVIDERS, name)
  if (!found) return failed('invalid_input')
  const now = deps.now ?? Date.now
  const startedAt = now()
  const result = await run(deps, found.provider, name, input)
  await record(deps.db, result, {
    privyUserId: NO_LOGIN,
    clientId: NO_LOGIN,
    grantId: NO_LOGIN,
    provider: found.provider.name,
    tool: name,
    durationMs: Math.max(0, now() - startedAt),
    createdAt: startedAt,
    input: JSON.stringify(input),
    country: country ?? null,
  })
  return result.outcome
}

/** Makes one activity insert attempt; a failure never fails the tool call. */
async function record(
  db: D1Database,
  { network, credits, outcome }: Awaited<ReturnType<typeof run>>,
  call: Omit<
    typeof toolActivity.$inferInsert,
    'id' | 'network' | 'status' | 'credits' | 'errorCode'
  >,
) {
  try {
    await drizzle(db)
      .insert(toolActivity)
      .values({
        ...call,
        id: crypto.randomUUID(),
        network,
        status: outcome.ok ? 'ok' : 'failed',
        credits,
        errorCode: outcome.ok ? null : outcome.error.code,
      })
  } catch {
    // D1 may include bound values in its errors. Log only a fixed diagnostic.
    console.error('Could not record tool activity')
  }
}

/** Configures the provider and runs one tool, never throwing. */
async function run(
  deps: Pick<CallToolDeps, 'env' | 'fetch'>,
  provider: HostedProvider,
  name: string,
  input: unknown,
) {
  let network: SolanaNetwork['name'] | null = null
  let credits = 0
  let outcome: ToolReply
  try {
    const configured = await provider.configure(deps.env, deps.fetch ?? fetch)
    network = configured.network
    try {
      const response = await configured.run(name, input)
      credits =
        Number.isSafeInteger(response.credits) && response.credits >= 0
          ? response.credits
          : 0
      if (!response.ok) outcome = { ok: false, error: response.error }
      else if (response.summary === undefined)
        outcome = { ok: true, result: response.result }
      else
        outcome = {
          ok: true,
          result: response.result,
          summary: response.summary,
        }
    } catch {
      outcome = failed('upstream_error')
    }
  } catch {
    outcome = failed('network_unavailable')
  }

  return { network, credits, outcome }
}
