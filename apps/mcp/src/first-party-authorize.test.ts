import { beforeEach, expect, mock, test } from 'bun:test'
import { z } from 'zod'

const MOBILE_REDIRECT = 'lanatools://oauth/callback'
const USER_ID = 'did:privy:user-1'
const GRANT_ID = '3665bb2c-0930-485a-97e2-3a431b5888d2'

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

let active = true
const api = {
  recordConsent: mock(async (_input: unknown) => {}),
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
    active ? { userId: USER_ID, clientId: 'client' } : null,
  ),
}
const env = {
  MCP_ORIGIN: 'http://localhost:8788',
  FIRST_PARTY_CLIENT_IDS: '',
  OAUTH_KV: memoryKV(),
  API: api,
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

function send(path: string, init?: RequestInit) {
  return provider.fetch(
    new Request(new URL(path, env.MCP_ORIGIN), init),
    env as never,
    ctx,
  )
}

async function register(name: string, redirect: string) {
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

const mobile = await register('LanaTools Mobile', MOBILE_REDIRECT)
const thirdParty = await register('Other Client', MOBILE_REDIRECT)
const verifier = crypto.randomUUID() + crypto.randomUUID()
const challenge = Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
).toString('base64url')

function authorize(
  body: Record<string, unknown> = {},
  token: string | null = 'privy-valid',
) {
  return send('/first-party/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      client_id: mobile,
      redirect_uri: MOBILE_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-1',
      resource: `${env.MCP_ORIGIN}/mcp`,
      decision: 'approve',
      scopes: ['helius:read', 'payments:pay'],
      limitUsd: '5',
      ...body,
    }),
  })
}

async function approvedCode() {
  const response = await authorize()
  expect(response.status).toBe(200)
  return z
    .object({ code: z.string(), state: z.literal('state-1') })
    .parse(await response.json()).code
}

function postToken(params: Record<string, string>) {
  return send('/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: mobile, ...params }),
  })
}

const Tokens = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  scope: z.string(),
})

async function exchange(code: string) {
  const response = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: MOBILE_REDIRECT,
    code_verifier: verifier,
  })
  expect(response.status).toBe(200)
  return Tokens.parse(await response.json())
}

function refresh(refreshToken: string) {
  return postToken({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

async function expectRefused(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(await response.json()).toHaveProperty('error')
  expect(api.recordConsent).not.toHaveBeenCalled()
  expect(api.prepareGrant).not.toHaveBeenCalled()
  expect(api.activateGrant).not.toHaveBeenCalled()
}

beforeEach(() => {
  active = true
  env.FIRST_PARTY_CLIENT_IDS = ` unlisted-client, ${mobile} `
  for (const method of Object.values(api)) method.mockClear()
})

test('an approved request returns a code that exchanges for tokens', async () => {
  const tokens = await exchange(await approvedCode())
  expect(tokens.scope).toBe('account:read helius:read payments:pay')
  expect(api.verifyPrivyToken).toHaveBeenCalledWith('privy-valid')
  const consent = z
    .object({ handle: z.string() })
    .loose()
    .parse(api.recordConsent.mock.calls[0]?.[0])
  expect(consent).toEqual({
    handle: consent.handle,
    clientId: mobile,
    clientName: 'LanaTools Mobile',
    redirectUri: MOBILE_REDIRECT,
  })
  expect(api.activateGrant.mock.calls[0]).toEqual([
    consent.handle,
    { grantId: GRANT_ID, userId: USER_ID, clientId: mobile },
    ['helius:read', 'payments:pay'],
    5_000_000,
  ])
  expect((await refresh(tokens.refresh_token)).status).toBe(200)
})

test('a revoked grant cannot refresh its tokens', async () => {
  const tokens = await exchange(await approvedCode())
  active = false
  const response = await refresh(tokens.refresh_token)
  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
})

test('connecting again signs the previous device out', async () => {
  const first = await exchange(await approvedCode())
  const second = await exchange(await approvedCode())
  expect((await refresh(first.refresh_token)).status).toBe(400)
  expect((await refresh(second.refresh_token)).status).toBe(200)
})

test('a deny issues no grant', async () => {
  const response = await authorize({ decision: 'deny' }, null)
  await expectRefused(response, 403)
  expect(api.verifyPrivyToken).not.toHaveBeenCalled()
})

test('clients outside the allowlist must use the consent page', async () => {
  await expectRefused(await authorize({ client_id: thirdParty }), 403)
  await expectRefused(await authorize({ client_id: 'unknown' }), 403)
  env.FIRST_PARTY_CLIENT_IDS = ''
  await expectRefused(await authorize(), 403)
})

test('an allowlisted client must still be registered', async () => {
  await expectRefused(await authorize({ client_id: 'unlisted-client' }), 400)
})

test('requests without S256 PKCE or the registered redirect are refused', async () => {
  await expectRefused(await authorize({ code_challenge_method: 'plain' }), 400)
  await expectRefused(await authorize({ code_challenge: undefined }), 400)
  await expectRefused(
    await authorize({ redirect_uri: 'lanatools://other/callback' }),
    400,
  )
  await expectRefused(
    await authorize({ resource: 'https://example.com/mcp' }),
    400,
  )
})

test('allowing payments needs a spending limit', async () => {
  const response = await authorize({ limitUsd: undefined })
  await expectRefused(response, 400)
})

test('a missing or forged Privy token is refused', async () => {
  await expectRefused(await authorize({}, null), 401)
  await expectRefused(await authorize({}, 'forged'), 401)
})

test('a spending limit without payments is refused before any sign-out', async () => {
  const signedIn = await exchange(await approvedCode())
  api.recordConsent.mockClear()
  api.prepareGrant.mockClear()
  api.activateGrant.mockClear()
  await expectRefused(
    await authorize({ scopes: ['helius:read'], limitUsd: '5' }),
    400,
  )
  expect((await refresh(signedIn.refresh_token)).status).toBe(200)
})

test('unexpected failures return a JSON 500', async () => {
  const get = env.OAUTH_KV.get
  env.OAUTH_KV.get = async () => {
    throw new Error('KV unavailable')
  }
  try {
    const response = await authorize()
    expect(response.status).toBe(500)
    expect(await response.json()).toHaveProperty('error')
  } finally {
    env.OAUTH_KV.get = get
  }

  api.activateGrant.mockImplementationOnce(async () => {
    throw new Error('D1 unavailable')
  })
  const response = await authorize()
  expect(response.status).toBe(500)
  expect(await response.json()).toHaveProperty('error')
})
