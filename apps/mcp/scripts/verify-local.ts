import assert from 'node:assert/strict'
import { z } from 'zod'

const origin = 'http://localhost:8788'
const resource = `${origin}/mcp`
const callback = 'http://127.0.0.1:8932/callback'
const verifier = crypto.randomUUID() + crypto.randomUUID()
const challenge = Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
).toString('base64url')

let receive!: (url: URL) => void
const received = new Promise<URL>((resolve) => {
  receive = resolve
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 8932,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/callback')
      return new Response('Not found', { status: 404 })
    receive(url)
    return new Response(
      'LanaTools MCP authorization returned. You can close this tab.',
      { headers: { 'Content-Type': 'text/plain' } },
    )
  },
})

try {
  let clientId = process.env.LANATOOLS_MCP_CLIENT_ID
  if (!clientId) {
    const registered = await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'LanaTools local verification',
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
      }),
    })
    assert.equal(registered.status, 201)
    const client = z
      .object({ client_id: z.string().min(1) })
      .parse(await registered.json())
    clientId = client.client_id
  }
  const state = crypto.randomUUID()
  const authorize = new URL(`${origin}/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: callback,
    scope: 'account:read',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  }).toString()
  console.log(`OPEN_AUTH_URL ${authorize.href}`)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('OAuth callback timed out')),
      10 * 60_000,
    )
  })
  const returned = await Promise.race([received, timeout])
  clearTimeout(timer)
  assert.equal(returned.searchParams.get('state'), state)
  assert.equal(returned.searchParams.get('error'), null)
  const code = returned.searchParams.get('code')
  assert.ok(code)

  const exchanged = await fetch(`${origin}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  })
  assert.equal(
    exchanged.status,
    200,
    `Token exchange returned ${exchanged.status}`,
  )
  const token = z
    .object({ access_token: z.string().min(1), token_type: z.string() })
    .parse(await exchanged.json())
  assert.equal(token.token_type.toLowerCase(), 'bearer')
  console.log('TOKEN_EXCHANGE passed')

  async function mcp(method: string, id: number, params: object) {
    const response = await fetch(resource, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    assert.equal(response.status, 200, `${method} returned ${response.status}`)
    const body = await response.text()
    const data =
      body
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim() ?? body
    assert.ok(data)
    const parsed: unknown = JSON.parse(data)
    return parsed
  }

  const initialized = z
    .object({
      result: z.object({ serverInfo: z.object({ name: z.string() }) }),
    })
    .parse(
      await mcp('initialize', 1, {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'lanatools-local-verification', version: '0.1.0' },
      }),
    )
  assert.equal(initialized.result.serverInfo.name, 'LanaTools')
  console.log('MCP_INITIALIZE passed')
  const listed = z
    .object({
      result: z.object({ tools: z.array(z.object({ name: z.string() })) }),
    })
    .parse(await mcp('tools/list', 2, {}))
  assert.ok(listed.result.tools.some((tool) => tool.name === 'whoami'))
  console.log('MCP_TOOLS_LIST passed')
  const called = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ text: z.string().optional() })),
      }),
    })
    .parse(await mcp('tools/call', 3, { name: 'whoami', arguments: {} }))
  assert.notEqual(
    called.result.isError,
    true,
    called.result.content.map((item) => item.text).join(' '),
  )
  const account = z
    .object({ userId: z.string().min(1), clientId: z.string() })
    .parse(JSON.parse(called.result.content[0]?.text || ''))
  assert.equal(account.clientId, clientId)
  console.log('MCP_WHOAMI passed')
  assert.ok(
    listed.result.tools.some((tool) => tool.name === 'phoenix_get_market'),
  )
  const market = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ text: z.string().optional() })),
      }),
    })
    .parse(
      await mcp('tools/call', 4, {
        name: 'phoenix_get_market',
        arguments: { symbol: 'SOL' },
      }),
    )
  assert.notEqual(
    market.result.isError,
    true,
    market.result.content.map((item) => item.text).join(' '),
  )
  assert.equal(
    z
      .object({ symbol: z.string() })
      .parse(JSON.parse(market.result.content[0]?.text || '')).symbol,
    'SOL',
  )
  console.log('MCP_PHOENIX passed')
} finally {
  server.stop(true)
}
