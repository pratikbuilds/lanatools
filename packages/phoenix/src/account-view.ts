import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
} from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import type { PhoenixAccount } from '@lanatools/contracts'
import { PhoenixError, createPhoenixClient } from './client'
import type { PhoenixClient, PhoenixOpts } from './client'
import { AllMarketStats, MarketConfigs, TraderState } from './schemas'
import { fromLots, tidy, usdc } from './units'

/**
 * One wallet's Phoenix account for a dashboard: collateral, positions with
 * their liquidation prices, and resting orders. Liquidation prices and
 * margin come from Phoenix's own trader view, so they match Phoenix's app.
 */

const PHOENIX_PROGRAM = address('EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih')

/** A Phoenix amount; `ui` is its exact decimal text. */
const Amount = z.object({ ui: z.string() })

const TraderView = z.object({
  riskState: z.string(),
  portfolioValue: Amount,
  unrealizedPnl: Amount,
  maintenanceMargin: Amount,
  positions: z
    .array(
      z.object({
        symbol: z.string(),
        positionValue: Amount,
        unrealizedPnl: Amount,
        liquidationPrice: Amount.nullish(),
      }),
    )
    .default([]),
})
type TraderView = z.output<typeof TraderView>

/** The trader account Phoenix keeps for one subaccount of a wallet. */
export async function traderSubaccountAddress(
  wallet: Address,
  subaccount: number,
) {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PHOENIX_PROGRAM,
    seeds: [
      'trader',
      getAddressEncoder().encode(wallet),
      new Uint8Array([0]),
      new Uint8Array([subaccount]),
    ],
  })
  return pda
}

/** "120.9300" → "120.93"; "-0.500000" → "-0.5". */
const decimal = (text: string) =>
  text.includes('.') ? text.replace(/\.?0+$/, '') : text

/** Phoenix reports -1 for a position that cannot be liquidated. */
const liquidation = (text: string | undefined) =>
  text !== undefined && Number(text) > 0 ? decimal(text) : null

/** A USD decimal string as micro-dollars, the precision Phoenix reports. */
function micros(text: string) {
  const negative = text.startsWith('-')
  const [whole = '0', fraction = ''] = text.replace(/^-/, '').split('.')
  const value =
    BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6))
  return negative ? -value : value
}

/** Exact sums of USD amounts. */
const sumOf = (values: string[]) =>
  usdc(values.reduce((sum, value) => sum + micros(value), 0n).toString())

function side(value: string): 'buy' | 'sell' {
  return ['bid', 'buy', '0'].includes(value.toLowerCase()) ? 'buy' : 'sell'
}

async function view(
  client: PhoenixClient,
  wallet: Address,
  subaccount: number,
) {
  const trader = await traderSubaccountAddress(wallet, subaccount)
  return client
    .get(`/v1/view/trader/${trader}`, TraderView)
    .catch((error: unknown) => {
      // A subaccount Phoenix has not indexed yet still has its state.
      if (error instanceof PhoenixError && error.code === 'not_found')
        return null
      throw error
    })
}

export async function readPhoenixAccount(
  wallet: string,
  opts: PhoenixOpts = {},
): Promise<PhoenixAccount> {
  const client = createPhoenixClient(opts)
  const owner = address(wallet)
  const state = await client
    .get(`/v1/trader/state/${encodeURIComponent(owner)}`, TraderState)
    .catch((error: unknown) => {
      if (error instanceof PhoenixError && error.code === 'not_found')
        return null
      throw error
    })
  // Phoenix answers a wallet that never traded with an empty state.
  if (!state || state.snapshot.subaccounts.length === 0)
    return {
      wallet: owner,
      exists: false,
      accountValueUsd: '0',
      collateralUsdc: '0',
      unrealizedPnlUsd: '0',
      maintenanceMarginUsd: '0',
      leverage: null,
      riskState: null,
      positions: [],
      orders: [],
    }

  const subaccounts = state.snapshot.subaccounts
  const active = subaccounts.filter(
    (sub) =>
      sub.positions.some((p) => BigInt(p.basePositionLots) !== 0n) ||
      sub.orders.length > 0,
  )
  // Phoenix values a subaccount's spot collateral (SOL and the like); its
  // trader view is read for those too, not only for trading subaccounts.
  const valued = subaccounts.filter(
    (sub) =>
      active.includes(sub) ||
      sub.spotCollaterals.some((spot) => BigInt(spot.balance) !== 0n),
  )
  const [views, configs, stats] = await Promise.all([
    Promise.all(
      valued.map(async (sub) => ({
        subaccount: sub.subaccountIndex,
        view: await view(client, owner, sub.subaccountIndex),
      })),
    ),
    active.length ? client.get('/v1/view/exchange/markets', MarketConfigs) : [],
    active.length
      ? client.get('/v1/markets/stats/latest', AllMarketStats)
      : { markets: [] },
  ])
  const viewOf = new Map(views.map((each) => [each.subaccount, each.view]))
  const decimalsOf = new Map(
    configs.map((config) => [config.symbol, config.baseLotsDecimals]),
  )
  const markOf = new Map(
    stats.markets.map((market) => [market.symbol, market.mark_price]),
  )
  const lotsDecimals = (symbol: string) => {
    const decimals = decimalsOf.get(symbol)
    if (decimals === undefined)
      throw new PhoenixError(
        'upstream_error',
        `Phoenix returned a position in unknown market ${symbol}`,
      )
    return decimals
  }

  const positions = active.flatMap((sub) => {
    const traderView: TraderView | null | undefined = viewOf.get(
      sub.subaccountIndex,
    )
    return sub.positions
      .filter((position) => BigInt(position.basePositionLots) !== 0n)
      .map((position) => {
        const size = fromLots(
          position.basePositionLots,
          lotsDecimals(position.symbol),
        )
        const mark = markOf.get(position.symbol)
        const viewed = traderView?.positions.find(
          (each) => each.symbol === position.symbol,
        )
        const unpriced =
          mark === undefined
            ? null
            : tidy(
                Number(size) * mark +
                  Number(usdc(position.virtualQuotePositionLots)),
              ).toString()
        return {
          symbol: position.symbol,
          subaccount: sub.subaccountIndex,
          marginMode:
            sub.subaccountIndex === 0
              ? ('cross' as const)
              : ('isolated' as const),
          side: size.startsWith('-') ? ('short' as const) : ('long' as const),
          size: size.replace(/^-/, ''),
          entryPrice: position.entryPriceUsd
            ? decimal(position.entryPriceUsd)
            : null,
          markPrice: mark === undefined ? null : tidy(mark).toString(),
          valueUsd: viewed
            ? decimal(viewed.positionValue.ui).replace(/^-/, '')
            : mark === undefined
              ? null
              : tidy(Math.abs(Number(size)) * mark).toString(),
          unrealizedPnlUsd: viewed
            ? decimal(viewed.unrealizedPnl.ui)
            : unpriced,
          liquidationPrice: liquidation(viewed?.liquidationPrice?.ui),
          fundingUsdc: usdc(position.accumulatedFundingQuoteLots),
        }
      })
  })

  const orders = active.flatMap((sub) =>
    sub.orders.flatMap((book) =>
      book.orders
        .filter((order) => order.status !== 'closed')
        .map((order) => ({
          symbol: book.symbol,
          subaccount: sub.subaccountIndex,
          orderId: order.orderSequenceNumber,
          side: side(order.side),
          type: order.orderType,
          price: decimal(order.priceUsd),
          size: fromLots(order.sizeRemainingLots, lotsDecimals(book.symbol)),
          reduceOnly: order.reduceOnly,
        })),
    ),
  )

  const collateralUsdc = usdc(
    subaccounts
      .reduce((sum, sub) => sum + BigInt(sub.collateral), 0n)
      .toString(),
  )
  const viewed = views.flatMap((each) => (each.view ? [each.view] : []))
  // Portfolio value is collateral plus unrealized PnL, as Phoenix margins
  // it. A subaccount without positions is worth its collateral.
  const idle = subaccounts
    .filter((sub) => !viewOf.get(sub.subaccountIndex))
    .map((sub) => usdc(sub.collateral))
  const accountValueUsd = sumOf([
    ...viewed.map((each) => each.portfolioValue.ui),
    ...idle,
  ])
  const exposure = positions.reduce(
    (sum, position) => sum + Number(position.valueUsd ?? 0),
    0,
  )
  const ranked = ['healthy', 'unhealthy', 'underwater']
  const riskState =
    viewed
      .map((each) => each.riskState)
      .sort((a, b) => ranked.indexOf(b) - ranked.indexOf(a))[0] ?? null
  return {
    wallet: state.authority,
    exists: true,
    accountValueUsd,
    collateralUsdc,
    unrealizedPnlUsd: sumOf(
      positions.map((position) => position.unrealizedPnlUsd ?? '0'),
    ),
    maintenanceMarginUsd: sumOf(
      viewed.map((each) => each.maintenanceMargin.ui),
    ),
    leverage:
      Number(accountValueUsd) > 0
        ? tidy(exposure / Number(accountValueUsd)).toString()
        : null,
    riskState,
    positions,
    orders,
  }
}
