import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { heliusTools } from '@lanatools/helius'
import {
  assertNoSecrets,
  chainFixtures,
  verifyLocalLedger,
  verifyWorkerLog,
} from './verify-chain'
import type { ChainFixture } from './verify-chain'

const origin = process.env.LANATOOLS_MCP_ORIGIN ?? 'http://localhost:8788'
const chain = process.argv.includes('--chain-read')
// Validate every exported tool fixture before opening an OAuth flow.
const fixtures = chain
  ? chainFixtures(process.env)
  : new Map<string, ChainFixture>()
const secrets = [process.env.HELIUS_API_KEY ?? '']
if (chain)
  assert.ok(
    ['localhost', '127.0.0.1'].includes(new URL(origin).hostname),
    'The chain verification pass targets the local devnet Workers only',
  )
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
    scope: chain ? 'account:read chain:read' : 'account:read',
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

  const client = new Client({
    name: 'lanatools-local-verification',
    version: '0.1.0',
  })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        requestInit: {
          headers: { Authorization: `Bearer ${token.access_token}` },
        },
      }),
    )
    assert.equal(client.getServerVersion()?.name, 'LanaTools')
    console.log('MCP_INITIALIZE passed')
    const listed = await client.listTools()
    assertNoSecrets(listed, secrets)
    assert.ok(listed.tools.some((tool) => tool.name === 'whoami'))
    console.log('MCP_TOOLS_LIST passed')
    const called = await client.callTool({ name: 'whoami', arguments: {} })
    assertNoSecrets(called, secrets)
    assert.notEqual(called.isError, true, 'whoami returned a tool error')
    const content = z
      .array(z.object({ text: z.string().optional() }))
      .parse(called.content)
    const account = z
      .object({ userId: z.string().min(1), clientId: z.string() })
      .parse(JSON.parse(content[0]?.text || ''))
    assert.equal(account.clientId, clientId)
    console.log('MCP_WHOAMI passed')
    const market = await client.callTool({
      name: 'phoenix_get_market',
      arguments: { symbol: 'SOL' },
    })
    assertNoSecrets(market, secrets)
    assert.notEqual(market.isError, true)
    const marketContent = z
      .array(z.object({ text: z.string().optional() }))
      .parse(market.content)
    assert.equal(
      z
        .object({ symbol: z.string() })
        .parse(JSON.parse(marketContent[0]?.text || '')).symbol,
      'SOL',
    )
    console.log('MCP_PHOENIX passed')

    if (chain) {
      const started = Date.now()
      for (const tool of heliusTools) {
        const advertised = listed.tools.find(
          (entry) => entry.name === tool.name,
        )
        assert.ok(advertised, `Missing exported tool ${tool.name}`)
        assert.equal(advertised.annotations?.readOnlyHint, true)
        assert.equal(advertised.annotations.idempotentHint, true)
        assert.equal(advertised.annotations.destructiveHint, false)
        assert.equal(advertised.annotations.openWorldHint, true)
        assert.ok(!('network' in (advertised.inputSchema.properties ?? {})))
        const fixture = fixtures.get(tool.name)!
        const result = await client.callTool(
          { name: tool.name, arguments: fixture.input },
          { timeout: 120_000 },
        )
        assertNoSecrets(result, secrets)
        assert.notEqual(
          result.isError,
          true,
          `${tool.name} returned a tool error; inspect the safe error code locally`,
        )
        const shaped = fixture.output.safeParse(result.structuredContent)
        assert.ok(shaped.success, `${tool.name} returned an unexpected shape`)
        const text = z
          .array(z.object({ type: z.literal('text'), text: z.string() }))
          .parse(result.content)
        assert.equal(text.length, 1)
        assert.deepEqual(JSON.parse(text[0]!.text), result.structuredContent)
        console.log(`CHAIN_TOOL ${tool.name} passed`)
      }
      await verifyLocalLedger(
        clientId,
        started,
        Date.now(),
        heliusTools.map((tool) => tool.name),
      )
      console.log(
        'CHAIN_DEVNET_LEDGER passed: one row with credits per exported tool',
      )
      if (process.env.LANATOOLS_WORKER_LOG && secrets[0]) {
        await verifyWorkerLog(process.env.LANATOOLS_WORKER_LOG, secrets)
        console.log(
          'CHAIN_SECRETS passed: tool results and captured Worker logs',
        )
      } else {
        console.log(
          'CHAIN_SECRETS NOT_VERIFIED: set HELIUS_API_KEY for exact-key scanning and LANATOOLS_WORKER_LOG to the captured local Worker log',
        )
        process.exitCode = 2
      }
    }
  } finally {
    await client.close()
  }
} finally {
  server.stop(true)
}
