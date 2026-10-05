import { expect, test } from 'bun:test'
import { phoenixTools, runPhoenixTool } from './index'
import type { PhoenixFetch } from './index'
import { fromLots } from './units'

const WALLET = '9qSuwtfRWRhYK6JrfDFkHLP1iyfCxqG3PAswQUnq917u'

// Shapes trimmed from live perp-api.phoenix.trade responses (2026-10-04).
function config(symbol: string, baseLotsDecimals: number) {
  return {
    symbol,
    marketStatus: 'active',
    metadata: { name: symbol },
    baseLotsDecimals,
    takerFee: 0.00035,
    makerFee: 0.00005,
    leverageTiers: [
      { maxLeverage: 25.0, maxSizeBaseLots: 32164684 },
      { maxLeverage: 1.0, maxSizeBaseLots: 32164685 },
    ],
    fundingIntervalSeconds: 3600,
    maxFundingRatePerIntervalPercentage: 0.21873710276516714,
    openInterestCapBaseLots: '32164684',
    isolatedOnly: false,
  }
}

function stats(symbol: string, mark: number, volume: number) {
  return {
    symbol,
    timestamp_ms: '1791106799000',
    mark_price: mark,
    oracle_price: mark,
    prev_day_mark_price: mark / 2,
    open_interest: 10,
    day_volume_usd: volume,
    current_funding_rate: 0.00159429456682,
    eight_hour_funding_rate: 0.0127543565346,
    annualized_funding_rate: 13.9660204054,
  }
}

const MARKETS = [config('kBONK', -2), config('SOL', 2), config('NEW', 2)]
const STATS = {
  markets: [stats('kBONK', 0.004, 1000), stats('SOL', 121, 7_000_000)],
}

const position = (symbol: string, lots: string, virtualQuote: string) => ({
  symbol,
  basePositionLots: lots,
  entryPriceUsd: '119.85',
  virtualQuotePositionLots: virtualQuote,
  accumulatedFundingQuoteLots: '-891025',
})

function traderState(subaccounts: unknown[]) {
  return { authority: WALLET, snapshot: { subaccounts } }
}

function fakeFetch(routes: Record<string, unknown>) {
  const requests: URL[] = []
  const fetch: PhoenixFetch = async (url) => {
    const parsed = new URL(url)
    requests.push(parsed)
    const body = routes[parsed.pathname]
    if (body instanceof Response) return body
    if (body === undefined)
      return Response.json({ error: 'not found' }, { status: 404 })
    return Response.json(body)
  }
  return { fetch, requests }
}

async function run(
  name: string,
  input: unknown,
  routes: Record<string, unknown>,
) {
  const { fetch, requests } = fakeFetch(routes)
  return { outcome: await runPhoenixTool(name, input, { fetch }), requests }
}

function result(outcome: Awaited<ReturnType<typeof runPhoenixTool>>) {
  if (!outcome.ok) throw new Error(outcome.error.message)
  return outcome.result
}

test('fromLots converts lots to exact token amounts', () => {
  expect(fromLots('2044', 2)).toBe('20.44')
  expect(fromLots('-5', 2)).toBe('-0.05')
  expect(fromLots('6039078', 6)).toBe('6.039078')
  expect(fromLots('2000000', 6)).toBe('2')
  expect(fromLots('-3', -2)).toBe('-300')
  expect(fromLots('7', 0)).toBe('7')
})

test('the tool list matches the plan', () => {
  expect(phoenixTools.map((tool) => tool.name)).toEqual([
    'phoenix_list_markets',
    'phoenix_get_market',
    'phoenix_get_orderbook',
    'phoenix_get_candles',
    'phoenix_get_account',
    'phoenix_get_history',
  ])
})

test('list markets joins stats, sorts by volume and keeps unpriced markets', async () => {
  const { outcome } = await run(
    'phoenix_list_markets',
    {},
    {
      '/v1/view/exchange/markets': MARKETS,
      '/v1/markets/stats/latest': STATS,
    },
  )
  const { count, markets } = result(outcome) as {
    count: number
    markets: Record<string, unknown>[]
  }
  expect(count).toBe(3)
  expect(markets.map((market) => market.symbol)).toEqual([
    'SOL',
    'kBONK',
    'NEW',
  ])
  expect(markets[0]).toMatchObject({
    markPrice: 121,
    change24hPct: 100,
    maxLeverage: 25,
    openInterestUsd: 1210,
    fundingRatePct: { annualized: 13.96602041 },
  })
  expect(markets[2]).toMatchObject({ symbol: 'NEW', markPrice: null })
})

test('get market reports leverage tiers in tokens', async () => {
  const { outcome } = await run(
    'phoenix_get_market',
    { symbol: 'sol' },
    {
      '/v1/view/exchange/market/sol': config('SOL', 2),
      '/v1/market/sol/stats/latest': stats('SOL', 121, 1),
    },
  )
  expect(result(outcome)).toMatchObject({
    symbol: 'SOL',
    takerFeePct: 0.035,
    makerFeePct: 0.005,
    leverageTiers: [{ maxLeverage: 25, maxPositionSize: '321646.84' }, {}],
    openInterestCap: '321646.84',
  })
})

test('an unknown market points the agent at phoenix_list_markets', async () => {
  const { outcome } = await run('phoenix_get_orderbook', { symbol: 'NOPE' }, {})
  expect(outcome).toEqual({
    ok: false,
    error: {
      code: 'not_found',
      message:
        'Phoenix has no market NOPE; call phoenix_list_markets for valid symbols',
      retryable: false,
    },
    credits: 0,
  })
})

test('order book returns the requested depth with spread', async () => {
  const { outcome } = await run(
    'phoenix_get_orderbook',
    { symbol: 'SOL', depth: 1 },
    {
      '/v1/view/orderbook/SOL': {
        symbol: 'SOL',
        mid: 121.175,
        bids: [
          [121.17, 87.59],
          [121.16, 10],
        ],
        asks: [
          [121.18, 237.66],
          [121.19, 5],
        ],
      },
    },
  )
  expect(result(outcome)).toEqual({
    symbol: 'SOL',
    mid: 121.175,
    spread: 0.01,
    spreadBps: 0.83,
    bids: [{ price: 121.17, size: 87.59 }],
    asks: [{ price: 121.18, size: 237.66 }],
  })
})

test('candles pass timeframe and limit through', async () => {
  const { outcome, requests } = await run(
    'phoenix_get_candles',
    { symbol: 'SOL' },
    {
      '/v1/candles/SOL': [
        {
          time: 1791093600000,
          open: 120.86,
          high: 121.14,
          low: 120.73,
          close: 121.02999999999999,
          volume: 10,
          volumeQuote: 1210,
          tradeCount: 3,
        },
      ],
    },
  )
  expect(requests[0]?.search).toBe('?timeframe=1h&limit=50')
  expect(result(outcome)).toMatchObject({
    candles: [
      { time: '2026-10-04T06:00:00.000Z', close: 121.03, volumeUsdc: 1210 },
    ],
  })
})

test('a candle window keeps the newest candles and says it was truncated', async () => {
  const candle = (hour: number) => ({
    time: Date.UTC(2026, 9, 4, hour),
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    volumeQuote: 1,
    tradeCount: 1,
  })
  const { outcome, requests } = await run(
    'phoenix_get_candles',
    {
      symbol: 'SOL',
      limit: 2,
      from: '2026-10-04T00:00:00Z',
      to: '2026-10-04T03:00:00Z',
    },
    { '/v1/candles/SOL': [candle(0), candle(1), candle(2)] },
  )
  expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toEqual({
    timeframe: '1h',
    limit: '2',
    startTime: String(Date.UTC(2026, 9, 4, 0)),
    endTime: String(Date.UTC(2026, 9, 4, 3)),
  })
  expect(result(outcome)).toMatchObject({
    truncated: true,
    candles: [
      { time: '2026-10-04T01:00:00.000Z' },
      { time: '2026-10-04T02:00:00.000Z' },
    ],
  })
})

test('a candle window Phoenix rejects as too long tells the agent how to fix it', async () => {
  const { outcome } = await run(
    'phoenix_get_candles',
    {
      symbol: 'SOL',
      timeframe: '1m',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-03T00:00:00Z',
    },
    {
      '/v1/candles/SOL': Response.json(
        { error: 'Requested time range exceeds 2500 candles' },
        { status: 400 },
      ),
    },
  )
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      code: 'invalid_input',
      message: expect.stringContaining('larger timeframe'),
    },
  })
})

test('candle and history limits and windows are bounded', async () => {
  const inputs: [string, unknown][] = [
    ['phoenix_get_candles', { symbol: 'SOL', limit: 501 }],
    [
      'phoenix_get_candles',
      {
        symbol: 'SOL',
        from: '2026-10-04T03:00:00Z',
        to: '2026-10-04T00:00:00Z',
      },
    ],
    ['phoenix_get_candles', { symbol: 'SOL', from: 'yesterday' }],
    ['phoenix_get_history', { wallet: WALLET, type: 'trades', limit: 101 }],
  ]
  for (const [name, input] of inputs) {
    const { outcome, requests } = await run(name, input, {})
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(requests).toHaveLength(0)
  }
})

test('account converts lots, estimates PnL at mark and splits margin modes', async () => {
  const { outcome } = await run(
    'phoenix_get_account',
    { wallet: WALLET },
    {
      [`/v1/trader/state/${WALLET}`]: traderState([
        {
          subaccountIndex: 0,
          collateral: '6039078',
          spotCollaterals: [
            { symbol: 'SOL', balance: '2390000000', decimals: 9 },
          ],
          positions: [position('SOL', '2044', '-2449743820')],
          orders: [
            {
              symbol: 'SOL',
              orders: [
                {
                  orderSequenceNumber: '7',
                  side: 'ask',
                  orderType: 'limit',
                  priceUsd: '130',
                  sizeRemainingLots: '150',
                  reduceOnly: true,
                  status: 'open',
                },
              ],
            },
          ],
        },
        {
          subaccountIndex: 4,
          collateral: '1000000',
          positions: [position('kBONK', '-3', '1145100')],
        },
        { subaccountIndex: 9, collateral: '0' },
      ]),
      '/v1/view/exchange/markets': MARKETS,
      '/v1/markets/stats/latest': STATS,
    },
  )
  expect(result(outcome)).toEqual({
    wallet: WALLET,
    totals: {
      collateralUsdc: '7.039078',
      unrealizedPnlUsd: 23.44128,
      openPositions: 2,
      openOrders: 1,
    },
    collateral: [
      { subaccount: 0, marginMode: 'cross', usdc: '6.039078' },
      { subaccount: 4, marginMode: 'isolated', usdc: '1' },
    ],
    spotCollateral: [{ subaccount: 0, symbol: 'SOL', amount: '2.39' }],
    positions: [
      {
        symbol: 'SOL',
        subaccount: 0,
        marginMode: 'cross',
        side: 'long',
        size: '20.44',
        entryPrice: '119.85',
        markPrice: 121,
        notionalUsd: 2473.24,
        unrealizedPnlUsd: 23.49618,
        accumulatedFundingUsdc: '-0.891025',
      },
      {
        symbol: 'kBONK',
        subaccount: 4,
        marginMode: 'isolated',
        side: 'short',
        size: '300',
        entryPrice: '119.85',
        markPrice: 0.004,
        notionalUsd: 1.2,
        unrealizedPnlUsd: -0.0549,
        accumulatedFundingUsdc: '-0.891025',
      },
    ],
    openOrders: [
      {
        symbol: 'SOL',
        subaccount: 0,
        orderId: '7',
        side: 'sell',
        type: 'limit',
        price: '130',
        remainingSize: '1.5',
        reduceOnly: true,
        status: 'open',
      },
    ],
  })
})

test('an empty account skips the market lookups', async () => {
  const { outcome, requests } = await run(
    'phoenix_get_account',
    { wallet: WALLET },
    {
      [`/v1/trader/state/${WALLET}`]: traderState([
        { subaccountIndex: 0, collateral: '0' },
      ]),
    },
  )
  expect(requests).toHaveLength(1)
  expect(result(outcome)).toMatchObject({
    totals: { collateralUsdc: '0', openPositions: 0 },
    positions: [],
  })
})

test('invalid inputs fail before any request', async () => {
  const bad = await run('phoenix_get_account', { wallet: 'nope' }, {})
  expect(bad.outcome).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  })
  const orders = await run(
    'phoenix_get_history',
    { wallet: WALLET, type: 'orders' },
    {},
  )
  expect(orders.outcome).toMatchObject({
    ok: false,
    error: {
      code: 'invalid_input',
      message: expect.stringContaining('symbol'),
    },
  })
  expect([...bad.requests, ...orders.requests]).toHaveLength(0)
})

test('trade history pages with a cursor and reports sides', async () => {
  const { outcome, requests } = await run(
    'phoenix_get_history',
    { wallet: WALLET, type: 'trades', symbol: 'SOL', limit: 1, cursor: 'abc' },
    {
      [`/v1/trader/${WALLET}/trades-history`]: {
        data: [
          {
            marketSymbol: 'SOL',
            subaccountIndex: 0,
            timestamp: '2026-10-04T09:40:05Z',
            baseLotsDelta: '-0.03',
            price: '121.25000000000001',
            realizedPnl: '0.5',
            fees: '0.001274',
            liquidity: 'taker',
            tradeType: 'market',
            signature: 'sig',
          },
        ],
        nextCursor: 'next',
        hasMore: true,
      },
    },
  )
  expect(requests[0]?.search).toBe('?limit=1&cursor=abc&marketSymbol=SOL')
  expect(result(outcome)).toEqual({
    type: 'trades',
    trades: [
      {
        time: '2026-10-04T09:40:05Z',
        symbol: 'SOL',
        subaccount: 0,
        side: 'sell',
        size: 0.03,
        price: 121.25,
        feeUsdc: 0.001274,
        realizedPnlUsdc: 0.5,
        liquidity: 'taker',
        tradeType: 'market',
        signature: 'sig',
      },
    ],
    nextCursor: 'next',
  })
})

test('collateral history converts quote lots to USDC', async () => {
  const { outcome } = await run(
    'phoenix_get_history',
    { wallet: WALLET, type: 'collateral' },
    {
      [`/v1/trader/${WALLET}/collateral-history`]: {
        data: [
          {
            timestamp: '2026-10-04T09:45:24Z',
            traderSubaccountIndex: 0,
            eventType: 'transfer',
            amount: -95676,
            collateralAfter: 2530530351,
          },
        ],
        hasMore: false,
      },
    },
  )
  expect(result(outcome)).toEqual({
    type: 'collateral',
    events: [
      {
        time: '2026-10-04T09:45:24Z',
        subaccount: 0,
        type: 'transfer',
        amountUsdc: '-0.095676',
        balanceAfterUsdc: '2530.530351',
      },
    ],
    nextCursor: null,
  })
})

test('pnl history keeps the newest points first', async () => {
  const point = (startTime: number, cumulativePnl: number) => ({
    startTime,
    endTime: startTime + 3599,
    cumulativePnl,
    unrealizedPnl: 0,
    cumulativeFundingPayment: 0,
    cumulativeTakerFee: 0.5,
    cumulativeMakerFee: 0.25,
  })
  const { outcome, requests } = await run(
    'phoenix_get_history',
    { wallet: WALLET, type: 'pnl', limit: 2 },
    {
      [`/v1/users/${WALLET}/pnl`]: [
        point(1790658000, 1),
        point(1790661600, 2),
        point(1790665200, 3),
      ],
    },
  )
  expect(requests[0]?.search).toBe('?resolution=1h')
  const { points } = result(outcome) as { points: Record<string, unknown>[] }
  expect(points.map((p) => p.cumulativePnlUsd)).toEqual([3, 2])
  expect(points[0]).toMatchObject({ cumulativeFeesUsd: 0.75 })
})

test('rate limits are retryable and odd responses are upstream errors', async () => {
  const limited = await run(
    'phoenix_get_orderbook',
    { symbol: 'SOL' },
    {
      '/v1/view/orderbook/SOL': new Response('slow down', { status: 429 }),
    },
  )
  expect(limited.outcome).toMatchObject({
    ok: false,
    error: { code: 'rate_limited', retryable: true },
  })
  const odd = await run(
    'phoenix_get_orderbook',
    { symbol: 'SOL' },
    {
      '/v1/view/orderbook/SOL': { symbol: 'SOL', bids: 'nope' },
    },
  )
  expect(odd.outcome).toMatchObject({
    ok: false,
    error: { code: 'upstream_error', retryable: false },
  })
})
