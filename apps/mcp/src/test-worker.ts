import { expect, mock } from 'bun:test'
import { z } from 'zod'

/**
 * The MCP Worker as one module-level OAuthProvider, with an in-memory KV and a
 * fake API. Test files share it: `index.ts` is imported once per process.
 */

export const USER_ID = 'did:privy:user-1'
export const GRANT_ID = '3665bb2c-0930-485a-97e2-3a431b5888d2'

/** Enough of Workers KV for OAuthProvider: values, metadata and listing. */
function memoryKV() {
  const entries = new Map<string, { value: string; metadata?: unknown }>()
  return {
    async get(key: string, options?: string | { type?: string }) {
      const value = entries.get(key)?.value
      if (value === undefined) return null
      const type = typeof options === 'string' ? options : options?.type
      return type === 'json' ? JSON.parse(value) : value
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      entries.set(key, { value, metadata: options?.metadata })
    },
    async delete(key: string) {
      entries.delete(key)
    },
    async list(options: { prefix?: string } = {}) {
      const keys = [...entries]
        .filter(([name]) => name.startsWith(options.prefix ?? ''))
        .map(([name, { metadata }]) => ({ name, metadata }))
      return { keys, list_complete: true, cacheStatus: null }
    },
  }
}

/** Whether the API reports the grant as active on refresh. */
export const grant = { active: true }

export const api = {
  recordConsent: mock(async (_input: unknown) => {}),
  discardConsent: mock(async (_handle: string) => {}),
  verifyPrivyToken: mock(async (token: string) => {
    if (token !== 'privy-valid') throw new Error('Invalid Privy token')
    return USER_ID
  }),
  prepareGrant: mock(async () => ({ grantId: GRANT_ID })),
  activateGrant: mock(
    async (
      _handle: string,
      _identity: unknown,
      _toolScopes: string[],
      _limitMicroUsd: number | null,
    ) => {},
  ),
  whoami: mock(async () =>
    grant.active ? { userId: USER_ID, clientId: 'client' } : null,
  ),
  callPublicTool: mock(async (_name: string, _input: unknown) => ({
    ok: true,
    result: { markets: [] },
  })),
  createTransactionRequest: mock(
    async (_identity: unknown, _name: string, _input: unknown) => ({
      ok: false,
      error: { code: 'unavailable', message: 'Test', retryable: true },
    }),
  ),
}

/** Whether the no-login rate limit lets the next call through. */
export const noLogin = { allowed: true }

export const env = {
  MCP_ORIGIN: 'http://localhost:8788',
  FIRST_PARTY_CLIENT_IDS: '',
  OAUTH_KV: memoryKV(),
  API: api,
  NO_LOGIN_LIMITER: {
    limit: mock(async (_options: { key: string }) => ({
      success: noLogin.allowed,
    })),
  },
}
mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {},
  env,
}))
const { default: provider } = await import('./index')

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext

export function send(path: string, init?: RequestInit, cf?: object) {
  const request = new Request(new URL(path, env.MCP_ORIGIN), init)
  // Cloudflare sets this on real requests; a plain Request has none.
  if (cf) Object.defineProperty(request, 'cf', { value: cf })
  return provider.fetch(request, env as never, ctx)
}

export async function register(name: string, redirect: string) {
  const response = await send('/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
    }),
  })
  expect(response.status).toBe(201)
  return z.object({ client_id: z.string() }).parse(await response.json())
    .client_id
}

export const verifier = crypto.randomUUID() + crypto.randomUUID()
export const challenge = Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
).toString('base64url')

export function postToken(clientId: string, params: Record<string, string>) {
  return send('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, ...params }),
  })
}

export const Tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
})

/** Exchanges a code issued for `clientId` and `redirectUri` for tokens. */
export async function exchange(
  clientId: string,
  redirectUri: string,
  code: string,
) {
  const response = await postToken(clientId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  expect(response.status).toBe(200)
  return Tokens.parse(await response.json())
}

export function resetWorker() {
  grant.active = true
  noLogin.allowed = true
  env.NO_LOGIN_LIMITER.limit.mockClear()
  for (const method of Object.values(api)) method.mockClear()
}
