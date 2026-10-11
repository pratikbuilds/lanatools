import { beforeEach, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  api,
  challenge,
  env,
  exchange,
  register,
  resetWorker,
  send,
} from './test-worker'

const CALLBACK = 'http://localhost:9999/callback'
const client = await register('Web Client', CALLBACK)

/** Opens a consent request, returning its handle and the consent cookie. */
async function beginConsent() {
  const authorize = new URL('/authorize', env.MCP_ORIGIN)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: CALLBACK,
    state: 'state-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${env.MCP_ORIGIN}/mcp`,
    scope: 'account:read',
  }).toString()
  const response = await send(authorize.pathname + authorize.search)
  expect(response.status).toBe(302)
  const handle = new URL(
    response.headers.get('location') || '',
  ).searchParams.get('handle')
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!handle || !cookie) throw new Error('Consent did not begin')
  return { handle, cookie }
}

function decide(
  { handle, cookie }: { handle: string; cookie: string },
  body: Record<string, unknown>,
) {
  return send(`/consent?handle=${handle}`, {
    method: 'POST',
    headers: {
      Origin: env.MCP_ORIGIN,
      Cookie: cookie,
      'Content-Type': 'application/json',
      Authorization: 'Bearer privy-valid',
    },
    body: JSON.stringify(body),
  })
}

beforeEach(resetWorker)

test('an approval issues a code for the chosen tool families', async () => {
  const response = await decide(await beginConsent(), {
    decision: 'approve',
    scopes: ['payments:pay', 'helius:read'],
    limitUsd: '3',
  })
  expect(response.status).toBe(200)
  const { redirectTo } = z
    .object({ redirectTo: z.string() })
    .parse(await response.json())
  const code = new URL(redirectTo).searchParams.get('code') || ''
  const tokens = await exchange(client, CALLBACK, code)
  expect(tokens.scope).toBe('account:read helius:read payments:pay')
  expect(api.activateGrant.mock.calls[0]?.slice(2)).toEqual([
    ['payments:pay', 'helius:read'],
    3_000_000,
  ])
})

test('a limit without payments is refused before the consent is used', async () => {
  const consent = await beginConsent()
  const refused = await decide(consent, {
    decision: 'approve',
    scopes: ['helius:read'],
    limitUsd: '3',
  })
  expect(refused.status).toBe(400)
  expect(api.prepareGrant).not.toHaveBeenCalled()
  const approved = await decide(consent, {
    decision: 'approve',
    scopes: ['helius:read'],
  })
  expect(approved.status).toBe(200)
})

test('a deny is not held back by the tool choice', async () => {
  const response = await decide(await beginConsent(), {
    decision: 'deny',
    limitUsd: 'abc',
  })
  expect(response.status).toBe(200)
  expect(api.discardConsent).toHaveBeenCalled()
  expect(api.prepareGrant).not.toHaveBeenCalled()
})
