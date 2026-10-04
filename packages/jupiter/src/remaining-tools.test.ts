import { expect, test } from 'bun:test'
import { JupiterClient } from './index'
import type { JupiterRequest, JupiterOutcome, JupiterData } from './index'

const sol = 'So11111111111111111111111111111111111111112'
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
function result(out: JupiterOutcome): JupiterData {
  expect(out.ok).toBe(true)
  if (!out.ok) throw new Error(out.error.message)
  return out.result.data
}
function reader(body: unknown, calls: URL[] = []) {
  return new JupiterClient({
    apiKey: 'test-key',
    fetch: async (url, init) => {
      expect(init?.method).toBe('GET')
      calls.push(new URL(url))
      return Response.json(body)
    },
  })
}

test('public portfolio routes retain records and failed/unknown fetchers mark partial data', async () => {
  const calls: URL[] = []
  const body = {
    owner: sol,
    date: 123,
    fetcherReports: [
      { id: 'one', status: 'ok' },
      { id: 'two', status: 'failed', error: 'failed' },
    ],
    elements: [{ amount: '9007199254740993' }],
    newField: null,
  }
  const client = reader(body, calls)
  expect(
    result(
      await client.read({
        tool: 'jupiter_get_portfolio',
        input: {
          view: 'positions',
          wallet: sol,
          platforms: ['jupiter-exchange', 'jupiter-exchange'],
        },
      }),
    ),
  ).toEqual({ view: 'positions', wallet: sol, portfolio: body, partial: true })
  expect(calls[0]!.pathname).toBe(`/portfolio/v1/positions/${sol}`)
  expect(calls[0]!.searchParams.get('platforms')).toBe('jupiter-exchange')
  for (const status of ['succeeded', 'ok', 'unknown'])
    expect(
      result(
        await reader({ fetcherReports: [{ status }], elements: [] }).read({
          tool: 'jupiter_get_portfolio',
          input: { view: 'positions', wallet: sol },
        }),
      ),
    ).toMatchObject({ partial: status === 'unknown' })
  expect(
    result(
      await reader({ elements: [] }).read({
        tool: 'jupiter_get_portfolio',
        input: { view: 'positions', wallet: sol },
      }),
    ),
  ).toMatchObject({ partial: true })
  const stake = {
    stakedAmount: 12.123456789,
    unstaking: [{ amount: 1, until: 123, extra: null }],
  }
  expect(
    result(
      await reader(stake, calls).read({
        tool: 'jupiter_get_portfolio',
        input: { view: 'staked_jup', wallet: sol },
      }),
    ),
  ).toMatchObject(stake)
  expect(calls.at(-1)!.pathname).toBe(`/portfolio/v1/staked-jup/${sol}`)
  const platforms = [
    { id: 'platform', links: { website: 'https://example.com' }, extra: null },
  ]
  expect(
    result(
      await reader(platforms, calls).read({
        tool: 'jupiter_get_portfolio',
        input: { view: 'platforms' },
      }),
    ),
  ).toEqual({ view: 'platforms', platforms })
  expect(calls.at(-1)!.pathname).toBe('/portfolio/v1/platforms')
})

test('lending routes preserve full precision, deduplicate addresses and strip custom RPC inputs', async () => {
  const record = {
    supply: '9007199254740993',
    borrow: '1000000000000000000',
    supplyRate: '471',
    dustBorrow: '2',
    extra: null,
  }
  const cases: Array<[JupiterRequest, string, Record<string, string>]> = [
    [
      { tool: 'jupiter_get_lending_markets', input: { view: 'earn_tokens' } },
      '/lend/v1/earn/tokens',
      {},
    ],
    [
      { tool: 'jupiter_get_lending_markets', input: { view: 'borrow_vaults' } },
      '/lend/v1/borrow/vaults',
      { market: 'main' },
    ],
    [
      {
        tool: 'jupiter_get_lending_markets',
        input: { view: 'borrow_vaults', market: 'ethena' },
      },
      '/lend/v1/borrow/vaults',
      { market: 'ethena' },
    ],
    [
      {
        tool: 'jupiter_get_lending_positions',
        input: { view: 'earn_positions', wallets: [sol, sol, usdc] },
      },
      '/lend/v1/earn/positions',
      { users: [sol, usdc].join(',') },
    ],
    [
      {
        tool: 'jupiter_get_lending_positions',
        input: { view: 'borrow_positions', wallets: [sol], market: 'ethena' },
      },
      '/lend/v1/borrow/positions',
      { users: sol, market: 'ethena' },
    ],
    [
      {
        tool: 'jupiter_get_lending_positions',
        input: {
          view: 'earn_earnings',
          wallet: sol,
          positionAddresses: [usdc, usdc],
        },
      },
      '/lend/v1/earn/earnings',
      { user: sol, positions: usdc },
    ],
  ]
  for (const [request, path, parameters] of cases) {
    const calls: URL[] = []
    const data = result(
      await reader([record], calls).read({
        ...request,
        input: { ...request.input, rpcUrl: 'https://untrusted.example' },
      } as unknown as JupiterRequest),
    )
    expect(calls[0]!.pathname).toBe(path)
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual(parameters)
    expect(JSON.stringify(data)).toContain('9007199254740993')
  }
  const earnings = { address: usdc, earnings: 1, slot: 12, extra: null }
  for (const shape of [earnings, [earnings]])
    expect(
      result(
        await reader(shape).read({
          tool: 'jupiter_get_lending_positions',
          input: {
            view: 'earn_earnings',
            wallet: sol,
            positionAddresses: [usdc],
          },
        }),
      ),
    ).toMatchObject({ earnings: [earnings] })
})

test('legacy order views use public user, fixed time DCA and explicit pagination only', async () => {
  const calls: URL[] = []
  const price = result(
    await reader(
      {
        orders: [{ id: 'order', amount: '123' }],
        totalPages: 4,
        totalItems: 32,
        page: 2,
      },
      calls,
    ).read({
      tool: 'jupiter_get_trigger_orders',
      input: {
        view: 'legacy_price_orders',
        wallet: sol,
        orderStatus: 'history',
        page: 2,
        inputMint: usdc,
      },
    }),
  )
  expect(price).toMatchObject({
    apiVersion: 'v1',
    maintenance: 'legacy',
    pagination: { page: 2, hasMoreData: true, totalPages: 4, totalItems: 32 },
  })
  expect(calls[0]!.pathname).toBe('/trigger/v1/getTriggerOrders')
  expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({
    user: sol,
    orderStatus: 'history',
    page: '2',
    inputMint: usdc,
  })
  const dca = result(
    await reader({ orders: [], hasMoreData: false }, calls).read({
      tool: 'jupiter_get_trigger_orders',
      input: {
        view: 'legacy_dca_orders',
        wallet: sol,
        orderStatus: 'active',
        includeFailedTx: false,
        outputMint: usdc,
      },
    }),
  )
  expect(dca).toMatchObject({
    orders: [],
    pagination: { page: 1, hasMoreData: false },
  })
  expect(calls[1]!.pathname).toBe('/recurring/v1/getRecurringOrders')
  expect(Object.fromEntries(calls[1]!.searchParams)).toEqual({
    user: sol,
    orderStatus: 'active',
    page: '1',
    recurringType: 'time',
    includeFailedTx: 'false',
    outputMint: usdc,
  })
  expect(
    result(
      await reader({ orders: [] }).read({
        tool: 'jupiter_get_trigger_orders',
        input: {
          view: 'legacy_price_orders',
          wallet: sol,
          orderStatus: 'active',
        },
      }),
    ),
  ).toMatchObject({ pagination: { hasMoreData: null } })
  expect(
    await reader({}).read({
      tool: 'jupiter_get_trigger_orders',
      input: { view: 'private_orders', wallet: sol },
    } as unknown as JupiterRequest),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})

function quoteReader(quote: Record<string, unknown> = {}, decimals = 6) {
  const calls: URL[] = []
  const client = new JupiterClient({
    apiKey: 'test-key',
    fetch: async (url) => {
      const parsed = new URL(url)
      calls.push(parsed)
      return Response.json(
        parsed.pathname === '/tokens/v2/search'
          ? [
              { id: usdc, decimals },
              { id: sol, decimals: 9 },
            ]
          : {
              inputMint: usdc,
              outputMint: sol,
              inAmount: '10000001',
              outAmount: '123456789',
              otherAmountThreshold: '120000000',
              swapMode: 'ExactIn',
              slippageBps: 50,
              router: 'metis',
              priceImpact: -0.1,
              feeBps: 1,
              routePlan: [
                {
                  swapInfo: { outAmount: '123456789' },
                  transaction: 'nested-payload',
                },
              ],
              transaction: 'payload',
              ...quote,
            },
      )
    },
  })
  return { client, calls }
}
const quoteRequest = {
  tool: 'jupiter_quote_swap',
  input: {
    inputMint: usdc,
    outputMint: sol,
    amount: '10.000001',
    maxSlippageBps: 50,
    minOutputAmount: '0.12',
  },
} as const

test('quotes convert exact amounts, report constraints/units and remove all transaction payloads', async () => {
  const { client, calls } = quoteReader()
  const data = result(
    await client.read({
      ...quoteRequest,
      input: { ...quoteRequest.input, taker: sol },
    } as unknown as JupiterRequest),
  )
  expect(calls[0]!.searchParams.get('query')).toBe([usdc, sol].join(','))
  expect(calls[1]!.pathname).toBe('/swap/v2/order')
  expect(Object.fromEntries(calls[1]!.searchParams)).toEqual({
    inputMint: usdc,
    outputMint: sol,
    amount: '10000001',
    swapMode: 'ExactIn',
    slippageBps: '50',
  })
  expect(data).toMatchObject({
    inputAmount: { decimal: '10.000001', baseUnits: '10000001', decimals: 6 },
    expectedOutput: {
      decimal: '0.123456789',
      baseUnits: '123456789',
      decimals: 9,
    },
    minimumOutput: { decimal: '0.12' },
    constraints: { satisfied: true },
    priceImpact: { percentagePoints: -0.1 },
    fees: { feeBps: 1 },
  })
  expect(JSON.stringify(data)).not.toContain('payload')
  expect(JSON.stringify(data)).not.toContain('transaction')
  const tooHigh = result(
    await quoteReader().client.read({
      ...quoteRequest,
      input: { ...quoteRequest.input, minOutputAmount: '0.121' },
    }),
  )
  expect(tooHigh).toMatchObject({ constraints: { satisfied: false } })
  const unknown = result(
    await quoteReader({ otherAmountThreshold: null }).client.read(quoteRequest),
  )
  expect(unknown).toMatchObject({
    minimumOutput: null,
    constraints: { satisfied: null },
  })
})

test('quote conversion rejects excess precision, invalid identities and unavailable routes without trading', async () => {
  const { client, calls } = quoteReader()
  expect(
    await client.read({
      ...quoteRequest,
      input: { ...quoteRequest.input, amount: '10.0000001' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(calls).toHaveLength(1)
  for (const invalid of [{ outAmount: '0' }, { error: 'No route' }])
    expect(await quoteReader(invalid).client.read(quoteRequest)).toMatchObject({
      ok: false,
      error: { code: 'no_route' },
    })
  expect(
    await quoteReader({ inAmount: '1' }).client.read(quoteRequest),
  ).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
  expect(
    await quoteReader({}, undefined).client.read({
      ...quoteRequest,
      input: { ...quoteRequest.input, amount: '18446744073709551616' },
    }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  const exact = quoteReader({ inAmount: '9007199254740993' }, 0)
  expect(
    result(
      await exact.client.read({
        ...quoteRequest,
        input: { inputMint: usdc, outputMint: sol, amount: '9007199254740993' },
      }),
    ),
  ).toMatchObject({
    inputAmount: { baseUnits: '9007199254740993', decimal: '9007199254740993' },
  })
  expect(exact.calls[1]!.searchParams.has('slippageBps')).toBe(false)
})

test('venues retain the full mapping and unusable top-level shapes fail', async () => {
  const mapping = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => ['program-' + i, 'venue-' + i]),
  )
  const calls: URL[] = []
  expect(
    result(
      await reader(mapping, calls).read({
        tool: 'jupiter_get_swap_venues',
        input: {},
      }),
    ),
  ).toEqual({ venues: mapping })
  expect(calls[0]!.pathname).toBe('/swap/v2/program-id-to-label')
  expect(
    await reader([]).read({ tool: 'jupiter_get_swap_venues', input: {} }),
  ).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
})

test('documented HTTP no-route errors are structured and arbitrary provider bodies stay private', async () => {
  const make = (error: string) =>
    new JupiterClient({
      apiKey: 'test-key',
      fetch: async (url) =>
        Response.json(
          new URL(url).pathname === '/tokens/v2/search'
            ? [
                { id: usdc, decimals: 6 },
                { id: sol, decimals: 9 },
              ]
            : { error },
          { status: new URL(url).pathname === '/tokens/v2/search' ? 200 : 400 },
        ),
    })
  expect(await make('No routes found').read(quoteRequest)).toMatchObject({
    ok: false,
    error: { code: 'no_route', retryable: false },
  })
  const out = await make('secret provider error').read(quoteRequest)
  expect(out).toMatchObject({
    ok: false,
    error: { code: 'upstream_unavailable', retryable: false },
  })
  expect(JSON.stringify(out)).not.toContain('secret')
})

test('legacy DCA always supplies includeFailedTx even when the agent omits it', async () => {
  const calls: URL[] = []
  const outcome = await reader(
    {
      time: [{ id: 'dca-order', depositAmount: '9007199254740993' }],
      totalPages: 1,
      totalItems: 1,
      page: 1,
    },
    calls,
  ).read({
    tool: 'jupiter_get_trigger_orders',
    input: { view: 'legacy_dca_orders', wallet: sol, orderStatus: 'active' },
  })
  expect(result(outcome)).toMatchObject({
    orders: [{ id: 'dca-order', depositAmount: '9007199254740993' }],
    pagination: { hasMoreData: false },
  })
  expect(calls[0]!.searchParams.get('includeFailedTx')).toBe('false')
  expect(calls[0]!.searchParams.get('recurringType')).toBe('time')
})
