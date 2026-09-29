import assert from 'node:assert/strict'
import { z } from 'zod'

const origin = 'http://localhost:8788'
const callback = 'http://127.0.0.1:8932/callback'
const resource = new URL('/mcp', origin).href

const unauthorized = await fetch(resource)
assert.equal(unauthorized.status, 401)
assert.match(
  unauthorized.headers.get('www-authenticate') || '',
  /resource_metadata=/,
)

const registration = await fetch(new URL('/register', origin), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    client_name: 'LanaTools smoke test',
    redirect_uris: [callback],
    token_endpoint_auth_method: 'none',
  }),
})
assert.equal(registration.status, 201)
const client: { client_id: string } = await registration.json()

const verifier = crypto.randomUUID() + crypto.randomUUID()
const digest = await crypto.subtle.digest(
  'SHA-256',
  new TextEncoder().encode(verifier),
)
const challenge = Buffer.from(digest).toString('base64url')
const authorize = new URL('/authorize', origin)
authorize.search = new URLSearchParams({
  response_type: 'code',
  client_id: client.client_id,
  redirect_uri: callback,
  scope: 'account:read',
  state: 'smoke-state',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource,
}).toString()
const started = await fetch(authorize, { redirect: 'manual' })
assert.equal(started.status, 302)
const location = new URL(started.headers.get('location') || '')
assert.equal(location.origin, origin)
assert.equal(location.pathname, '/connect')
const handle = location.searchParams.get('handle')
assert.ok(handle)
const cookie = (started.headers.get('set-cookie') || '').split(';')[0]
assert.ok(cookie)

const page = await fetch(location, { headers: { Cookie: cookie } })
assert.equal(page.status, 200)
assert.match(page.headers.get('content-type') || '', /text\/html/)
assert.match(
  page.headers.get('content-security-policy') || '',
  /script-src 'self'/,
)
assert.match(
  page.headers.get('content-security-policy') || '',
  /frame-ancestors 'none'/,
)
assert.match(await page.text(), /Connect an MCP client/)

const consent = new URL('/consent', origin)
consent.searchParams.set('handle', handle)
const pending = await fetch(consent, { headers: { Cookie: cookie } })
assert.equal(pending.status, 200)
const pendingBody = z
  .object({
    clientName: z.string(),
    clientId: z.string(),
    scopes: z.tuple([z.literal('account:read')]),
  })
  .parse(await pending.json())
assert.equal(pendingBody.clientName, 'LanaTools smoke test')
assert.deepEqual(pendingBody.scopes, ['account:read'])
assert.equal(pendingBody.clientId, client.client_id)

const wrongOrigin = await fetch(consent, {
  method: 'POST',
  headers: {
    Origin: 'https://lanatools.sh',
    Cookie: cookie,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ decision: 'deny' }),
})
assert.equal(wrongOrigin.status, 403)

const headers = { Origin: origin, Cookie: cookie }

const unsigned = await fetch(consent, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ decision: 'approve' }),
})
assert.equal(unsigned.status, 401)

const denied = await fetch(consent, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ decision: 'deny' }),
})
assert.equal(denied.status, 200)
const deniedBody: unknown = await denied.json()
assert.ok(
  deniedBody && typeof deniedBody === 'object' && 'redirectTo' in deniedBody,
)
assert.ok(typeof deniedBody.redirectTo === 'string')
const redirect = new URL(deniedBody.redirectTo)
assert.equal(redirect.origin + redirect.pathname, callback)
assert.equal(redirect.searchParams.get('error'), 'access_denied')
assert.equal(redirect.searchParams.get('state'), 'smoke-state')

const replay = await fetch(consent, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ decision: 'deny' }),
})
assert.equal(replay.status, 400)
console.log(
  'MCP OAuth discovery, registration, browser-bound consent, denial, and replay checks passed',
)
