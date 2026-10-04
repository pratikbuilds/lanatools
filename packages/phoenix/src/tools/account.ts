import { z } from 'zod'
import { PhoenixError } from '../client'
import type { PhoenixClient } from '../client'
import {
  AllMarketStats,
  CollateralHistory,
  FundingHistory,
  MarketConfigs,
  OrderHistory,
  PnlHistory,
  TradeHistory,
  TraderState,
} from '../schemas'
import { MarketSymbol, UNTRUSTED, Wallet, defineTool } from '../tool'
import { fromLots, isoTime, tidy, usdc } from '../units'

const usd = (value: number) => Number(value.toFixed(6))

// Subaccount 0 is the cross-margin account; the others each hold one
// isolated position.
const marginMode = (subaccount: number) =>
  subaccount === 0 ? 'cross' : 'isolated'

function side(value: string | number) {
  const normalized = String(value).toLowerCase()
  if (['bid', 'buy', '0'].includes(normalized)) return 'buy'
  if (['ask', 'sell', '1'].includes(normalized)) return 'sell'
  return normalized
}

async function marketsBySymbol(client: PhoenixClient) {
  const [configs, stats] = await Promise.all([
    client.get('/v1/view/exchange/markets', MarketConfigs),
    client.get('/v1/markets/stats/latest', AllMarketStats),
  ])
  const marks = new Map(stats.markets.map((item) => [item.symbol, item]))
  return new Map(
    configs.map((config) => [
      config.symbol,
      {
        decimals: config.baseLotsDecimals,
        mark: marks.get(config.symbol)?.mark_price ?? null,
      },
    ]),
  )
}

export const getAccount = defineTool({
  name: 'phoenix_get_account',
  title: 'Read a Phoenix trading account',
  description: [
    "Reads any wallet's Phoenix perps account: USDC collateral, open positions (size in tokens, entry and mark price, unrealized PnL at mark) and resting orders, across the cross-margin and isolated subaccounts.",
    'Does not need the wallet to sign. A wallet that never traded on Phoenix shows zero collateral and no positions.',
    UNTRUSTED,
  ].join(' '),
  input: z.object({ wallet: Wallet }).strict(),
  async run(client, { wallet }) {
    const state = await client.get(
      `/v1/trader/state/${encodeURIComponent(wallet)}`,
      TraderState,
    )
    const subaccounts = state.snapshot.subaccounts
    const busy = subaccounts.some(
      (sub) => sub.positions.length > 0 || sub.orders.length > 0,
    )
    // Market sizes and marks are only needed for positions and orders.
    const markets = busy ? await marketsBySymbol(client) : null
    const market = (symbol: string) => {
      const found = markets?.get(symbol)
      if (!found)
        throw new PhoenixError(
          'upstream_error',
          `Phoenix returned a position in unknown market ${symbol}`,
        )
      return found
    }

    const positions = subaccounts.flatMap((sub) =>
      sub.positions
        .filter((position) => BigInt(position.basePositionLots) !== 0n)
        .map((position) => {
          const { decimals, mark } = market(position.symbol)
          const size = fromLots(position.basePositionLots, decimals)
          const amount = Number(size)
          return {
            symbol: position.symbol,
            subaccount: sub.subaccountIndex,
            marginMode: marginMode(sub.subaccountIndex),
            side: amount > 0 ? 'long' : 'short',
            size: size.replace(/^-/, ''),
            entryPrice: position.entryPriceUsd ?? null,
            markPrice: mark === null ? null : tidy(mark),
            notionalUsd: mark === null ? null : usd(Math.abs(amount) * mark),
            // Size × mark plus the virtual quote position, as Phoenix
            // margins it; an estimate until the position is closed.
            unrealizedPnlUsd:
              mark === null
                ? null
                : usd(
                    amount * mark +
                      Number(usdc(position.virtualQuotePositionLots)),
                  ),
            accumulatedFundingUsdc: usdc(position.accumulatedFundingQuoteLots),
          }
        }),
    )

    const openOrders = subaccounts.flatMap((sub) =>
      sub.orders.flatMap((book) =>
        book.orders.map((order) => ({
          symbol: book.symbol,
          subaccount: sub.subaccountIndex,
          orderId: order.orderSequenceNumber,
          side: side(order.side),
          type: order.orderType,
          price: order.priceUsd,
          remainingSize: fromLots(
            order.sizeRemainingLots,
            market(book.symbol).decimals,
          ),
          reduceOnly: order.reduceOnly,
          status: order.status,
        })),
      ),
    )

    const collateral = subaccounts
      .filter((sub) => BigInt(sub.collateral) !== 0n)
      .map((sub) => ({
        subaccount: sub.subaccountIndex,
        marginMode: marginMode(sub.subaccountIndex),
        usdc: usdc(sub.collateral),
      }))
    const spotCollateral = subaccounts.flatMap((sub) =>
      sub.spotCollaterals
        .filter((spot) => BigInt(spot.balance) !== 0n)
        .map((spot) => ({
          subaccount: sub.subaccountIndex,
          symbol: spot.symbol,
          amount: fromLots(spot.balance, spot.decimals),
        })),
    )
    const totalCollateral = subaccounts.reduce(
      (sum, sub) => sum + BigInt(sub.collateral),
      0n,
    )
    const unpriced = positions.some((p) => p.unrealizedPnlUsd === null)

    return {
      wallet: state.authority,
      totals: {
        collateralUsdc: usdc(totalCollateral.toString()),
        unrealizedPnlUsd: unpriced
          ? null
          : usd(
              positions.reduce((sum, p) => sum + (p.unrealizedPnlUsd ?? 0), 0),
            ),
        openPositions: positions.length,
        openOrders: openOrders.length,
      },
      collateral,
      spotCollateral,
      positions,
      openOrders,
    }
  },
})

const HISTORY_TYPES = [
  'trades',
  'orders',
  'funding',
  'collateral',
  'pnl',
] as const

export const getHistory = defineTool({
  name: 'phoenix_get_history',
  title: 'Read Phoenix trading history',
  description: [
    "Reads any wallet's Phoenix perps history, newest first. type picks the feed: trades (fills), orders, funding (payments), collateral (deposits, withdrawals, transfers) or pnl (cumulative PnL over time).",
    'Pass nextCursor back as cursor for the next page (not for pnl). The orders feed needs a symbol.',
    UNTRUSTED,
  ].join(' '),
  input: z
    .object({
      wallet: Wallet,
      type: z.enum(HISTORY_TYPES),
      symbol: MarketSymbol.optional().describe(
        'Only this market (trades, orders and funding)',
      ),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).optional(),
      resolution: z
        .enum(['5m', '15m', '1h', '4h', '1d', '1w', '1M'])
        .default('1h')
        .describe('PnL bucket size (pnl only)'),
    })
    .strict(),
  async run(client, input) {
    const trader = `/v1/trader/${encodeURIComponent(input.wallet)}`
    const page = { limit: input.limit, cursor: input.cursor }
    const next = (feed: {
      nextCursor?: string | null | undefined
      hasMore: boolean
    }) => (feed.hasMore ? (feed.nextCursor ?? null) : null)

    switch (input.type) {
      case 'trades': {
        const feed = await client.get(
          `${trader}/trades-history`,
          TradeHistory,
          {
            ...page,
            marketSymbol: input.symbol,
          },
        )
        return {
          type: input.type,
          trades: feed.data.map((trade) => ({
            time: isoTime(trade.timestamp),
            symbol: trade.marketSymbol,
            subaccount: trade.subaccountIndex,
            side: trade.baseLotsDelta >= 0 ? 'buy' : 'sell',
            size: tidy(Math.abs(trade.baseLotsDelta)),
            price: tidy(trade.price),
            feeUsdc: tidy(trade.fees),
            realizedPnlUsdc: tidy(trade.realizedPnl),
            liquidity: trade.liquidity,
            tradeType: trade.tradeType,
            signature: trade.signature ?? null,
          })),
          nextCursor: next(feed),
        }
      }
      case 'orders': {
        // Phoenix times out on an unfiltered order history for active
        // traders, so the feed is read one market at a time.
        if (!input.symbol)
          throw new PhoenixError(
            'invalid_input',
            'The orders history needs a symbol; call it once per market',
          )
        const feed = await client.get(`${trader}/order-history`, OrderHistory, {
          ...page,
          marketSymbol: input.symbol,
        })
        return {
          type: input.type,
          orders: feed.data.map((order) => ({
            orderId: order.orderSequenceNumber,
            symbol: order.marketSymbol,
            status: order.status,
            side: side(order.side),
            price: order.price,
            size: order.baseQty,
            filledSize: order.filledBaseQty,
            remainingSize: order.remainingBaseQty,
            reduceOnly: order.isReduceOnly ?? false,
            placedAt: order.placedAt == null ? null : isoTime(order.placedAt),
            completedAt:
              order.completedAt == null ? null : isoTime(order.completedAt),
          })),
          nextCursor: next(feed),
        }
      }
      case 'funding': {
        const feed = await client.get(
          `${trader}/funding-history`,
          FundingHistory,
          {
            ...page,
            symbol: input.symbol,
          },
        )
        return {
          type: input.type,
          payments: feed.events.map((event) => ({
            time: isoTime(event.timestamp),
            symbol: event.symbol,
            paymentUsdc: tidy(event.fundingPayment),
            fundingRatePct: tidy(event.fundingRatePercentage),
            positionSide: event.positionSide.toLowerCase(),
            positionSize: tidy(event.positionSize),
          })),
          nextCursor: next(feed),
        }
      }
      case 'collateral': {
        const feed = await client.get(
          `${trader}/collateral-history`,
          CollateralHistory,
          page,
        )
        return {
          type: input.type,
          events: feed.data.map((event) => ({
            time: isoTime(event.timestamp),
            subaccount: Number(event.traderSubaccountIndex),
            type: event.eventType,
            amountUsdc: usdc(event.amount),
            balanceAfterUsdc: usdc(event.collateralAfter),
          })),
          nextCursor: next(feed),
        }
      }
      case 'pnl': {
        // Phoenix's `limit` on this route does not return the latest
        // buckets, so read the whole series and keep the newest ones.
        const series = await client.get(
          `/v1/users/${encodeURIComponent(input.wallet)}/pnl`,
          PnlHistory,
          { resolution: input.resolution },
        )
        return {
          type: input.type,
          resolution: input.resolution,
          points: series
            .slice(-input.limit)
            .reverse()
            .map((point) => ({
              start: isoTime(point.startTime),
              end: isoTime(point.endTime),
              cumulativePnlUsd: tidy(point.cumulativePnl),
              unrealizedPnlUsd: tidy(point.unrealizedPnl),
              cumulativeFundingUsd: tidy(point.cumulativeFundingPayment),
              cumulativeFeesUsd: tidy(
                point.cumulativeTakerFee + point.cumulativeMakerFee,
              ),
            })),
          nextCursor: null,
        }
      }
    }
  },
})
