import { expect, test } from 'bun:test'
import { address } from '@solana/kit'
import { readPhoenixAccount, traderSubaccountAddress } from './account-view'
import type { PhoenixFetch } from './index'

// Shapes trimmed from live perp-api.phoenix.trade responses (2026-10-11):
// wallet TEY5…FNQ held one cross-margin SOL short.
const WALLET = 'TEY5zgBjT247DQ5n9EiHrLmHW6TZmxRFRqLqGf4FQNQ'
const CROSS = 'CQeSAr4akpVF5p2xx65DFdtzcfzLjJTifw7dDddtFCHV'

const config = (symbol: string, baseLotsDecimals: number) => ({
  symbol,
  marketStatus: 'active',
  baseLotsDecimals,
  takerFee: 0.00035,
  makerFee: 0.00005,
  leverageTiers: [{ maxLeverage: 25.0, maxSizeBaseLots: 32164684 }],
  fundingIntervalSeconds: 3600,
  maxFundingRatePerIntervalPercentage: 0.2,
  openInterestCapBaseLots: '32164684',
  isolatedOnly: false,
})
const stats = (symbol: string, mark: number) => ({
  symbol,
  timestamp_ms: '1791710549000',
  mark_price: mark,
  oracle_price: mark,
  prev_day_mark_price: mark,
  open_interest: 10,
  day_volume_usd: 1,
  current_funding_rate: 0,
  eight_hour_funding_rate: 0,
  annualized_funding_rate: 0,
})
const amount = (ui: string) => ({ value: 0, decimals: 6, ui })

const STATE = {
  authority: WALLET,
  snapshot: {
    subaccounts: [
      {
        subaccountIndex: 0,
        collateral: '69530852186',
        positions: [
          {
            symbol: 'SOL',
            basePositionLots: '-721711',
            entryPriceUsd: '113.710000',
            virtualQuotePositionLots: '820624663442',
            accumulatedFundingQuoteLots: '1741748119',
          },
          {
            symbol: 'ETH',
            basePositionLots: '3',
            entryPriceUsd: '2500',
            virtualQuotePositionLots: '-7500000000',
            accumulatedFundingQuoteLots: '0',
          },
        ],
        orders: [
          {
            symbol: 'SOL',
            orders: [
              {
                orderSequenceNumber: '81204',
                side: 'bid',
                orderType: 'limit',
                priceUsd: '100.500000',
                sizeRemainingLots: '150',
                reduceOnly: true,
                status: 'open',
              },
            ],
          },
        ],
      },
    ],
  },
}
const VIEW = {
  riskState: 'healthy',
  portfolioValue: amount('99665.457328'),
  unrealizedPnl: amount('30134.605142'),
  maintenanceMargin: amount('15809.801166'),
  positions: [
    {
      symbol: 'SOL',
      positionValue: amount('-790490.058300'),
      unrealizedPnl: amount('30134.605142'),
      liquidationPrice: { value: 1209300, decimals: 4, ui: '120.9300' },
    },
    {
      symbol: 'ETH',
      positionValue: amount('7512.600000'),
      unrealizedPnl: amount('12.600000'),
      // Phoenix's way of saying it cannot be liquidated.
      liquidationPrice: { value: -1, decimals: 0, ui: '-1' },
    },
  ],
}

function fakeFetch(routes: Record<string, unknown>): PhoenixFetch {
  return async (url) => {
    const body = routes[new URL(url).pathname]
    return body === undefined
      ? Response.json({ error: 'not found' }, { status: 404 })
      : Response.json(body)
  }
}

test('the cross-margin trader account is derived as Phoenix derives it', async () => {
  expect(await traderSubaccountAddress(address(WALLET), 0)).toBe(address(CROSS))
})

test('an account carries Phoenix’s liquidation prices, value and leverage', async () => {
  const account = await readPhoenixAccount(WALLET, {
    fetch: fakeFetch({
      [`/v1/trader/state/${WALLET}`]: STATE,
      [`/v1/view/trader/${CROSS}`]: VIEW,
      '/v1/view/exchange/markets': [config('SOL', 2), config('ETH', 3)],
      '/v1/markets/stats/latest': {
        markets: [stats('SOL', 109.53), stats('ETH', 2504.2)],
      },
    }),
  })
  expect(account).toMatchObject({
    wallet: WALLET,
    exists: true,
    accountValueUsd: '99665.457328',
    collateralUsdc: '69530.852186',
    maintenanceMarginUsd: '15809.801166',
    riskState: 'healthy',
  })
  expect(account.positions[0]).toEqual({
    symbol: 'SOL',
    subaccount: 0,
    marginMode: 'cross',
    side: 'short',
    size: '7217.11',
    entryPrice: '113.71',
    markPrice: '109.53',
    valueUsd: '790490.0583',
    unrealizedPnlUsd: '30134.605142',
    liquidationPrice: '120.93',
    fundingUsdc: '1741.748119',
  })
  expect(account.positions[1]).toMatchObject({
    side: 'long',
    size: '0.003',
    liquidationPrice: null,
  })
  // (790490.0583 + 7512.6) / 99665.457328
  expect(Number(account.leverage)).toBeCloseTo(8.0068, 3)
  expect(account.orders).toEqual([
    {
      symbol: 'SOL',
      subaccount: 0,
      orderId: '81204',
      side: 'buy',
      type: 'limit',
      price: '100.5',
      size: '1.5',
      reduceOnly: true,
    },
  ])
})

test('a wallet without a Phoenix account is empty, not an error', async () => {
  const account = await readPhoenixAccount(WALLET, { fetch: fakeFetch({}) })
  expect(account).toMatchObject({
    exists: false,
    positions: [],
    orders: [],
    leverage: null,
  })
})

test('collateral alone needs no market or margin reads', async () => {
  const requests: string[] = []
  const routes: Record<string, unknown> = {
    [`/v1/trader/state/${WALLET}`]: {
      authority: WALLET,
      snapshot: {
        subaccounts: [{ subaccountIndex: 0, collateral: '25000000' }],
      },
    },
  }
  const account = await readPhoenixAccount(WALLET, {
    fetch: async (url, init) => {
      requests.push(new URL(url).pathname)
      return fakeFetch(routes)(url, init)
    },
  })
  expect(account).toMatchObject({
    exists: true,
    accountValueUsd: '25',
    collateralUsdc: '25',
    unrealizedPnlUsd: '0',
    leverage: '0',
    maintenanceMarginUsd: '0',
  })
  expect(requests).toEqual([`/v1/trader/state/${WALLET}`])
})

test('spot collateral counts at Phoenix’s value, not as zero USDC', async () => {
  const account = await readPhoenixAccount(WALLET, {
    fetch: fakeFetch({
      [`/v1/trader/state/${WALLET}`]: {
        authority: WALLET,
        snapshot: {
          subaccounts: [
            {
              subaccountIndex: 0,
              collateral: '0',
              spotCollaterals: [
                { symbol: 'SOL', balance: '2390000000', decimals: 9 },
              ],
            },
          ],
        },
      },
      [`/v1/view/trader/${CROSS}`]: {
        riskState: 'healthy',
        portfolioValue: amount('261.8'),
        unrealizedPnl: amount('0'),
        maintenanceMargin: amount('0'),
        positions: [],
      },
    }),
  })
  expect(account).toMatchObject({
    exists: true,
    accountValueUsd: '261.8',
    collateralUsdc: '0',
    positions: [],
  })
})
