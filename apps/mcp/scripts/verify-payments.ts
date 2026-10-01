/**
 * Connects a real MCP client (the official SDK) with `payments:pay`, then
 * exercises pay_http against the hosted devnet merchant. Open the printed
 * URL, sign in, set the client's limit, and approve.
 *
 *   bun run --cwd apps/mcp verify:payments            # full run
 *   bun run --cwd apps/mcp verify:payments -- refusals  # no spending
 *
 * Prints results only; never tokens or keys.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'

const origin = process.env.LANATOOLS_MCP_ORIGIN ?? 'http://localhost:8788'
const resource = `${origin}/mcp`
const callback = 'http://127.0.0.1:8933/callback'
const merchant = 'https://devnet-merchant-production.up.railway.app/api/v1'
const onlyRefusals = process.argv.includes('refusals')

const verifier = crypto.randomUUID() + crypto.randomUUID()
const challenge = Buffer.from(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
).toString('base64url')

let receive!: (url: URL) => void
const received = new Promise<URL>((resolve) => (receive = resolve))
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 8933,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/callback')
      return new Response('Not found', { status: 404 })
    receive(url)
    return new Response('Authorization returned. You can close this tab.')
  },
})

try {
  const registered: { client_id: string } = await (
    await fetch(`${origin}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name:
          process.env.CLIENT_NAME ?? 'LanaTools payment verification',
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json()
  const state = crypto.randomUUID()
  const authorize = new URL(`${origin}/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: registered.client_id,
    redirect_uri: callback,
    scope: 'account:read payments:pay',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource,
  }).toString()
  console.log(`OPEN_AUTH_URL ${authorize.href}`)

  const returned = await Promise.race([
    received,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('OAuth callback timed out')),
        15 * 60_000,
      ),
    ),
  ])
  if (returned.searchParams.get('state') !== state)
    throw new Error('State mismatch')
  const code = returned.searchParams.get('code')
  if (!code)
    throw new Error(
      `Authorization failed: ${returned.searchParams.get('error')}`,
    )
  const token: { access_token: string; scope?: string } = await (
    await fetch(`${origin}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        client_id: registered.client_id,
        code_verifier: verifier,
        resource,
      }),
    })
  ).json()
  console.log(`CONNECTED scope="${token.scope}"`)

  const client = new Client({
    name: 'lanatools-payment-verification',
    version: '0.1.0',
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: {
        headers: { Authorization: `Bearer ${token.access_token}` },
      },
    }),
  )
  const tools = await client.listTools()
  console.log(`TOOLS ${tools.tools.map((t) => t.name).join(', ')}`)

  async function pay(label: string, args: Record<string, unknown>) {
    const started = Date.now()
    const result = await client.callTool(
      { name: 'pay_http', arguments: args },
      { timeout: 180_000 },
    )
    const text = (result.content as Array<{ text?: string }>)
      .map((c) => c.text)
      .join(' ')
    console.log(
      `${result.isError ? 'REFUSED' : 'OK'} ${label} (${Date.now() - started} ms): ${text.slice(0, 400)}`,
    )
  }

  await pay('non-https', { url: 'http://example.com/', max_usd: '0.05' })
  await pay('private address', {
    url: 'https://169.254.169.254/latest',
    max_usd: '0.05',
  })
  await pay('max_usd below charge', {
    url: `${merchant}/fixed`,
    protocol: 'mpp',
    max_usd: '0.005',
  })
  if (!onlyRefusals) {
    await pay('mpp fixed', {
      url: `${merchant}/fixed`,
      protocol: 'mpp',
      max_usd: '0.05',
    })
    await pay('x402 fixed', {
      url: `${merchant}/fixed`,
      protocol: 'x402',
      max_usd: '0.05',
    })
    await pay('policy denied', {
      url: `${merchant}/policy-denied`,
      protocol: 'mpp',
      max_usd: '0.05',
    })
  }
  await client.close()
} finally {
  server.stop(true)
}
