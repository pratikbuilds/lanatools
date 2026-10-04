import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { JupiterRequest } from '@lanatools/jupiter'
import type { D1Database } from '@cloudflare/workers-types'
import { readJupiter } from './jupiter'
import {
  activateGrant,
  prepareGrant,
  recordConsent,
  revokeGrant,
} from './mcp-grants'
import { testDatabase } from './test-database'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

async function connect(scopes: string[]) {
  const handle = crypto.randomUUID()
  const clientId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId,
    clientName: 'Jupiter test',
    redirectUri: 'https://client.example/callback',
    scopes,
  })
  const { grantId } = await prepareGrant(db, handle, clientId, userId)
  const identity = { grantId, clientId, userId }
  await activateGrant(db, handle, identity)
  return identity
}

const request = {
  tool: 'jupiter_search_tokens' as const,
  input: { query: 'JUP' },
}
test('the API requires stored Jupiter scope and binds access to the grant owner/client', async () => {
  let calls = 0
  const fetcher = () => {
    calls++
    return Promise.resolve(Response.json([]))
  }
  const account = await connect(['account:read'])
  expect(
    await readJupiter(db, account, request, 'test-key', fetcher),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  const grant = await connect(['jupiter:read'])
  expect(
    await readJupiter(
      db,
      { ...grant, clientId: 'other-client' },
      request,
      'test-key',
      fetcher,
    ),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(
    await readJupiter(
      db,
      { ...grant, userId: 'other-user' },
      request,
      'test-key',
      fetcher,
    ),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(calls).toBe(0)
  expect(
    await readJupiter(db, grant, request, 'test-key', fetcher),
  ).toMatchObject({ ok: true, result: { data: { tokens: [] } } })
  expect(calls).toBe(1)
  await revokeGrant(db, grant.userId, grant.grantId)
  expect(
    await readJupiter(db, grant, request, 'test-key', fetcher),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(calls).toBe(1)
})

test('a missing provider key fails without fetching or requiring user credentials', async () => {
  const grant = await connect(['jupiter:read'])
  let calls = 0
  expect(
    await readJupiter(db, grant, request, undefined, () => {
      calls++
      return Promise.resolve(Response.json([]))
    }),
  ).toMatchObject({
    ok: false,
    error: { code: 'upstream_unavailable', retryable: false },
  })
  expect(calls).toBe(0)
})

test('all nine tools execute through the API grant boundary and revocation blocks every dispatch', async () => {
  const sol = 'So11111111111111111111111111111111111111112'
  const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const requests: JupiterRequest[] = [
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
      })
    if (path.includes('getTriggerOrders')) return Response.json({ orders: [] })
    if (path === '/price/v3' || path === '/swap/v2/program-id-to-label')
      return Response.json({})
    return Response.json([])
  }
  const grant = await connect(['jupiter:read'])
  for (const call of requests)
    expect(
      await readJupiter(db, grant, call, 'test-key', fetcher),
    ).toMatchObject({ ok: true, result: { source: 'jupiter' } })
  const successfulCalls = calls
  expect(successfulCalls).toBe(10)
  await revokeGrant(db, grant.userId, grant.grantId)
  for (const call of requests)
    expect(
      await readJupiter(db, grant, call, 'test-key', fetcher),
    ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(calls).toBe(successfulCalls)
})
