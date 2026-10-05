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
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { mcpGrant, toolActivity } from '../db/schema'
import type { GrantIdentity } from '../mcp-grants'
import { SOLANA_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import { runTool } from './run-tool'
import type { RunToolDeps } from './run-tool'

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

function dependencies(overrides: Partial<RunToolDeps> = {}): RunToolDeps {
  return {
    db,
    config: async () => ({ network: SOLANA_NETWORKS.devnet, rpcUrl: RPC_URL }),
    run: async () => ({
      ok: true,
      result: { content: 'private-result' },
      credits: 1,
    }),
    ...overrides,
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
  const run = mock(dependencies().run)
  let time = 1_000_000
  const input = { anything: 'private-input' }
  const result = await runTool(
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
  expect(run).toHaveBeenCalledWith('stub_tool', input, { rpcUrl: RPC_URL })
  expect(await rows()).toEqual([
    {
      id: expect.any(String),
      privyUserId: userId,
      clientId: identity.clientId,
      grantId: identity.grantId,
      provider: 'helius',
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
  await runTool(
    dependencies({
      config: async () => ({
        network: SOLANA_NETWORKS.mainnet,
        rpcUrl: RPC_URL,
      }),
    }),
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
    const result = await runTool(
      dependencies({
        run: async () => ({
          ok: false,
          error: { code, message: `${RPC_URL} private-input` },
          credits: 10,
        }),
      }),
      identity,
      'stub_tool',
      {},
    )
    expect(result).toMatchObject({ ok: false, error: { code } })
    expect(result).not.toHaveProperty('credits')
    expect(JSON.stringify(result)).not.toMatch(/private|api-key|rpc.example/)
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
  const result = await runTool(
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
  const run = mock(dependencies().run)
  const result = await runTool(
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

test('invalid tool metadata is rejected and never stored as arbitrary input', async () => {
  const identity = await connect()
  const run = mock(dependencies().run)
  const config = mock(dependencies().config)
  expect(
    await runTool(dependencies({ run, config }), identity, RPC_URL, {}),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(run).not.toHaveBeenCalled()
  expect(config).not.toHaveBeenCalled()
  expect(await rows()).toHaveLength(1)
  expect((await rows())[0]?.tool).toBe('invalid_tool')
})

test('pending and revoked grants never reach the network or get an activity row', async () => {
  for (const status of ['pending', 'revoked'] as const) {
    const identity = await connect({ status })
    const run = mock(dependencies().run)
    const config = mock(dependencies().config)
    expect(
      await runTool(dependencies({ run, config }), identity, 'stub_tool', {}),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(run).not.toHaveBeenCalled()
    expect(config).not.toHaveBeenCalled()
  }
  expect(await rows()).toEqual([])
})

test('grant, user and client identity must all match before any provider request', async () => {
  const identity = await connect()
  for (const key of ['grantId', 'userId', 'clientId'] as const) {
    const run = mock(dependencies().run)
    const config = mock(dependencies().config)
    const forged: GrantIdentity = { ...identity, [key]: 'not-the-owner' }
    expect(
      await runTool(dependencies({ run, config }), forged, 'stub_tool', {}),
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
    const run = mock(dependencies().run)
    const config = mock(dependencies().config)
    expect(
      await runTool(dependencies({ run, config }), identity, 'stub_tool', {}),
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
  const run = mock(dependencies().run)
  const result = await runTool(
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
    const run = mock(dependencies().run)
    const result = await runTool(
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
