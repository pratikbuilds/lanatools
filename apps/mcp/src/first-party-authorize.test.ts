import { beforeEach, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  GRANT_ID,
  USER_ID,
  api,
  challenge,
  env,
  exchange as exchangeFor,
  grant,
  postToken,
  register,
  resetWorker,
  send,
} from './test-worker'

const MOBILE_REDIRECT = 'lanatools://oauth/callback'

const mobile = await register('LanaTools Mobile', MOBILE_REDIRECT)
const thirdParty = await register('Other Client', MOBILE_REDIRECT)

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

function exchange(code: string) {
  return exchangeFor(mobile, MOBILE_REDIRECT, code)
}

function refresh(refreshToken: string) {
  return postToken(mobile, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
}

async function expectRefused(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(await response.json()).toHaveProperty('error')
  expect(api.recordConsent).not.toHaveBeenCalled()
  expect(api.prepareGrant).not.toHaveBeenCalled()
  expect(api.activateGrant).not.toHaveBeenCalled()
}

beforeEach(() => {
  resetWorker()
  env.FIRST_PARTY_CLIENT_IDS = ` unlisted-client, ${mobile} `
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
  grant.active = false
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

test('an empty state comes back empty', async () => {
  const response = await authorize({ state: '' })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: '' })
})

test('a body that is not JSON is refused', async () => {
  const response = await send('/first-party/authorize', {
    method: 'POST',
    body: 'not json',
  })
  await expectRefused(response, 400)
})
