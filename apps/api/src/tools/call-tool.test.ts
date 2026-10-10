import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { mcpGrant, toolActivity } from '../db/schema'
import {
  activateGrant,
  prepareGrant,
  recordConsent,
  revokeGrant,
} from '../mcp-grants'
import type { GrantIdentity } from '../mcp-grants'
import { testDatabase } from '../test-database'
import { callTool } from './call-tool'
import type { CallToolDeps } from './call-tool'
import type { ConfiguredProvider, HostedProvider } from './providers'

const RPC_URL = 'https://rpc.example/?api-key=private-provider-key'
let db: D1Database
let dispose: () => Promise<void>
let userId: string
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())
beforeEach(() => {
  userId = crypto.randomUUID()
})

async function connect({
  scope = 'helius:read',
  status = 'active',
}: {
  scope?: string
  status?: 'active' | 'pending' | 'revoked'
} = {}) {
  const identity = {
    userId,
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: userId,
    clientId: identity.clientId,
    scope,
    status,
    createdAt: Date.now(),
  })
  return identity
}

const ENV = { SOLANA_NETWORK: 'devnet', SOLANA_RPC_URL: RPC_URL }

type StubOptions = {
  db?: D1Database
  network?: ConfiguredProvider['network']
  run?: ConfiguredProvider['run']
  config?: () => Promise<void>
  now?: () => number
}

const defaultRun: ConfiguredProvider['run'] = async () => ({
  ok: true,
  result: { content: 'private-result' },
  credits: 1,
})

/** One stub provider with a `stub_tool`, needing helius:read like Helius. */
function dependencies(options: StubOptions = {}): CallToolDeps {
  const provider: HostedProvider = {
    name: 'stub',
    scope: 'helius:read',
    tools: [
      {
        name: 'stub_tool',
        title: 'Stub',
        description: 'A test tool',
        input: z.object({}),
      },
    ],
    async configure() {
      await options.config?.()
      return {
        network: options.network ?? 'devnet',
        run: options.run ?? defaultRun,
      }
    },
  }
  return {
    db: options.db ?? db,
    env: ENV,
    providers: [provider],
    ...(options.now ? { now: options.now } : {}),
  }
}

async function rows() {
  return drizzle(db)
    .select()
    .from(toolActivity)
    .where(eq(toolActivity.privyUserId, userId))
}

test('authorized generic calls pass only the server RPC and record one metadata-only row', async () => {
  const identity = await connect()
  const run = mock(defaultRun)
  let time = 1_000_000
  const input = { anything: 'private-input' }
  const result = await callTool(
    dependencies({
      run,
      now: () => {
        const current = time
        time += 25
        return current
      },
    }),
    identity,
    'stub_tool',
    input,
  )
  expect(result).toEqual({
    ok: true,
    result: { content: 'private-result' },
  })
  expect(run).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenCalledWith('stub_tool', input)
  expect(await rows()).toEqual([
    {
      id: expect.any(String),
      privyUserId: userId,
      clientId: identity.clientId,
      grantId: identity.grantId,
      provider: 'stub',
      tool: 'stub_tool',
      network: 'devnet',
      status: 'ok',
      credits: 1,
      errorCode: null,
      durationMs: 25,
      createdAt: 1_000_000,
    },
  ])
  expect(JSON.stringify(await rows())).not.toMatch(
    /private-input|private-result|api-key|rpc.example/,
  )
  const grant = await drizzle(db)
    .select()
    .from(mcpGrant)
    .where(eq(mcpGrant.id, identity.grantId))
    .get()
  expect(grant?.lastUsedAt).toBe(1_000_000)
})

test('configured mainnet is recorded for read-only tools', async () => {
  const identity = await connect()
  await callTool(
    dependencies({ network: 'mainnet' }),
    identity,
    'stub_tool',
    {},
  )
  expect((await rows())[0]?.network).toBe('mainnet')
})

for (const code of [
  'invalid_input',
  'rate_limited',
  'timeout',
  'plan_required',
  'upstream_error',
] as const) {
  test(`${code} returns a safe failure and records exactly one failed row`, async () => {
    const identity = await connect()
    const result = await callTool(
      dependencies({
        run: async () => ({
          ok: false,
          error: { code, message: 'A safe provider message', retryable: false },
          credits: 10,
        }),
      }),
      identity,
      'stub_tool',
      {},
    )
    expect(result).toEqual({
      ok: false,
      error: { code, message: 'A safe provider message', retryable: false },
    })
    expect(await rows()).toHaveLength(1)
    expect((await rows())[0]).toMatchObject({
      status: 'failed',
      errorCode: code,
      credits: 10,
    })
  })
}

test('provider exceptions become safe failed outcomes without exposing the URL', async () => {
  const identity = await connect()
  const result = await callTool(
    dependencies({
      run: async () => {
        throw new Error(RPC_URL)
      },
    }),
    identity,
    'stub_tool',
    {},
  )
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'upstream_error' },
  })
  expect(JSON.stringify(result)).not.toContain(RPC_URL)
  expect(await rows()).toHaveLength(1)
})

test('network configuration failures prevent provider calls and record one failed row', async () => {
  const identity = await connect()
  const run = mock(defaultRun)
  const result = await callTool(
    dependencies({
      run,
      config: async () => {
        throw new Error(RPC_URL)
      },
    }),
    identity,
    'stub_tool',
    {},
  )
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'network_unavailable' },
  })
  expect(run).not.toHaveBeenCalled()
  expect(await rows()).toHaveLength(1)
  expect((await rows())[0]).toMatchObject({
    status: 'failed',
    network: null,
    errorCode: 'network_unavailable',
  })
})

test('unknown tool names are rejected before any grant or activity work', async () => {
  const identity = await connect()
  const run = mock(defaultRun)
  const config = mock(async () => {})
  expect(
    await callTool(dependencies({ run, config }), identity, RPC_URL, {}),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(run).not.toHaveBeenCalled()
  expect(config).not.toHaveBeenCalled()
  expect(await rows()).toEqual([])
})

test('pending and revoked grants never reach the network or get an activity row', async () => {
  for (const status of ['pending', 'revoked'] as const) {
    const identity = await connect({ status })
    const run = mock(defaultRun)
    const config = mock(async () => {})
    expect(
      await callTool(dependencies({ run, config }), identity, 'stub_tool', {}),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(run).not.toHaveBeenCalled()
    expect(config).not.toHaveBeenCalled()
  }
  expect(await rows()).toEqual([])
})

test('grant, user and client identity must all match before any provider request', async () => {
  const identity = await connect()
  for (const key of ['grantId', 'userId', 'clientId'] as const) {
    const run = mock(defaultRun)
    const config = mock(async () => {})
    const forged: GrantIdentity = { ...identity, [key]: 'not-the-owner' }
    expect(
      await callTool(dependencies({ run, config }), forged, 'stub_tool', {}),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(run).not.toHaveBeenCalled()
    expect(config).not.toHaveBeenCalled()
  }
  expect(await rows()).toEqual([])
})

test('helius:read is independently required as an exact approved scope', async () => {
  for (const scope of [
    'account:read',
    'payments:pay',
    'phoenix:read',
    'chain:read',
    'helius:read-extra',
  ]) {
    const identity = await connect({ scope })
    const run = mock(defaultRun)
    const config = mock(async () => {})
    expect(
      await callTool(dependencies({ run, config }), identity, 'stub_tool', {}),
    ).toMatchObject({ ok: false, error: { code: 'insufficient_scope' } })
    expect(run).not.toHaveBeenCalled()
    expect(config).not.toHaveBeenCalled()
  }
  expect(await rows()).toEqual([])
})

test('an authorization database failure fails closed without leaking database details', async () => {
  const identity = await connect()
  const brokenDb = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return () => {
          throw new Error(RPC_URL)
        }
      return Reflect.get(target, key)
    },
  })
  const run = mock(defaultRun)
  const result = await callTool(
    dependencies({ db: brokenDb, run }),
    identity,
    'stub_tool',
    {},
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'upstream_error' } })
  expect(JSON.stringify(result)).not.toContain(RPC_URL)
  expect(run).not.toHaveBeenCalled()
  expect(await rows()).toEqual([])
})

test('a failed ledger insert is attempted only once and does not fail or repeat the tool', async () => {
  const identity = await connect()
  let inserts = 0
  const brokenDb = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (query: string) => {
          if (query.startsWith('insert into "tool_activity"')) {
            inserts++
            throw new Error(RPC_URL)
          }
          return target.prepare(query)
        }
      return Reflect.get(target, key)
    },
  })
  const log = spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const run = mock(defaultRun)
    const result = await callTool(
      dependencies({ db: brokenDb, run }),
      identity,
      'stub_tool',
      {},
    )
    expect(result.ok).toBe(true)
    expect(inserts).toBe(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('Could not record tool activity')
    expect(JSON.stringify(log.mock.calls)).not.toContain(RPC_URL)
    expect(await rows()).toEqual([])
  } finally {
    log.mockRestore()
  }
})

// The real providers, with fetch injected so nothing leaves the test.

async function consent(scopes: string[]) {
  const handle = crypto.randomUUID()
  const clientId = crypto.randomUUID()
  const owner = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId,
    clientName: 'Provider test',
    redirectUri: 'https://client.example/callback',
  })
  const { grantId } = await prepareGrant(db, handle, clientId, owner)
  const identity = { grantId, clientId, userId: owner }
  await activateGrant(db, handle, identity, scopes)
  return identity
}

function served(fetcher: (url: string) => Promise<Response>, key = 'test-key') {
  return {
    db,
    env: { ...ENV, JUPITER_API_KEY: key },
    fetch: fetcher,
  }
}

test('Jupiter needs the stored jupiter:read scope, bound to the grant owner and client', async () => {
  let calls = 0
  const fetcher = () => {
    calls++
    return Promise.resolve(Response.json([]))
  }
  const call = (identity: GrantIdentity) =>
    callTool(served(fetcher), identity, 'jupiter_search_tokens', {
      query: 'JUP',
    })
  const account = await consent([])
  expect(await call(account)).toMatchObject({
    ok: false,
    error: { code: 'insufficient_scope' },
  })
  const grant = await consent(['jupiter:read'])
  for (const forged of [
    { ...grant, clientId: 'other-client' },
    { ...grant, userId: 'other-user' },
  ])
    expect(await call(forged)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
  expect(calls).toBe(0)
  expect(await call(grant)).toMatchObject({
    ok: true,
    result: { data: { tokens: [] } },
    summary: expect.stringContaining('Returned 0 token records'),
  })
  expect(calls).toBe(1)
  await revokeGrant(db, grant.userId, grant.grantId)
  expect(await call(grant)).toMatchObject({
    ok: false,
    error: { code: 'unauthorized' },
  })
  expect(calls).toBe(1)
})

test('a missing Jupiter key fails without fetching or requiring user credentials', async () => {
  const grant = await consent(['jupiter:read'])
  let calls = 0
  expect(
    await callTool(
      served(() => {
        calls++
        return Promise.resolve(Response.json([]))
      }, ''),
      grant,
      'jupiter_search_tokens',
      { query: 'JUP' },
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'upstream_unavailable', retryable: false },
  })
  expect(calls).toBe(0)
})

test('Jupiter and Phoenix calls are recorded in activity like Helius', async () => {
  const grant = await consent(['jupiter:read', 'phoenix:read'])
  const fetcher = async (url: string) => {
    const path = new URL(url).pathname
    if (path === '/swap/v2/program-id-to-label') return Response.json({})
    return Response.json([])
  }
  await callTool(served(fetcher), grant, 'jupiter_get_swap_venues', {})
  await callTool(served(fetcher), grant, 'phoenix_list_markets', {})
  const recorded = await drizzle(db)
    .select()
    .from(toolActivity)
    .where(eq(toolActivity.grantId, grant.grantId))
  expect(
    recorded
      .map(({ provider, tool, network, status }) => ({
        provider,
        tool,
        network,
        status,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider)),
  ).toEqual([
    {
      provider: 'jupiter',
      tool: 'jupiter_get_swap_venues',
      network: 'mainnet',
      status: 'ok',
    },
    {
      provider: 'phoenix',
      tool: 'phoenix_list_markets',
      network: 'mainnet',
      status: expect.any(String),
    },
  ])
})

test('all ten Jupiter tools run through the API grant boundary and revocation blocks every dispatch', async () => {
  const sol = 'So11111111111111111111111111111111111111112'
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const requests = [
    { tool: 'jupiter_search_tokens', input: { query: 'JUP' } },
    { tool: 'jupiter_discover_tokens', input: { view: 'recent' } },
    { tool: 'jupiter_get_prices', input: { mints: [sol] } },
    { tool: 'jupiter_get_portfolio', input: { view: 'platforms' } },
    { tool: 'jupiter_get_lending_markets', input: { view: 'borrow_vaults' } },
    {
      tool: 'jupiter_get_lending_positions',
      input: { view: 'earn_positions', wallets: [sol] },
    },
    {
      tool: 'jupiter_get_trigger_orders',
      input: {
        view: 'legacy_price_orders',
        wallet: sol,
        orderStatus: 'active',
      },
    },
    {
      tool: 'jupiter_quote_swap',
      input: { inputMint: sol, outputMint: usdc, amount: '1' },
    },
    { tool: 'jupiter_get_swap_venues', input: {} },
  ]
  let calls = 0
  const fetcher = async (url: string) => {
    calls++
    const path = new URL(url).pathname
    if (path === '/tokens/v2/search')
      return Response.json([
        { id: sol, decimals: 9 },
        { id: usdc, decimals: 6 },
      ])
    if (path === '/swap/v2/order')
      return Response.json({
        inputMint: sol,
        outputMint: usdc,
        inAmount: '1000000000',
        outAmount: '100000000',
        taker: new URL(url).searchParams.get('taker'),
        transaction:
          'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAAAQabiFf+q4GE+2h/Y0YYwDXaxDncGus7VZig8AAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        requestId: 'request-1',
        router: 'metis',
        lastValidBlockHeight: '123',
      })
    if (path.includes('getTriggerOrders')) return Response.json({ orders: [] })
    if (path === '/price/v3' || path === '/swap/v2/program-id-to-label')
      return Response.json({})
    return Response.json([])
  }
  const grant = await consent(['jupiter:read'])
  for (const call of requests)
    expect(
      await callTool(served(fetcher), grant, call.tool, call.input),
    ).toMatchObject({ ok: true, result: { source: 'jupiter' } })
  const successfulCalls = calls
  expect(successfulCalls).toBe(10)
  await revokeGrant(db, grant.userId, grant.grantId)
  for (const call of requests)
    expect(
      await callTool(served(fetcher), grant, call.tool, call.input),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  expect(calls).toBe(successfulCalls)
})
