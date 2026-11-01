import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots } from '../../units'
import { checkPhoenixBundle } from '../checks'
import {
  fractionOfLots,
  limitRounding,
  priceToTicks,
  slippageLimit,
  ticksToPrice,
} from '../price'
import type { Side } from '../price'
import { MIN_FILL_LOTS } from '../rise'
import { ExchangeKeys } from '../schemas'
import type { OrderMarket } from '../schemas'
import { defineTradeTool } from '../tool'
import type { TradeContext } from '../tool'
import { immediateOrder, worstPrice } from './market-order'
import {
  MarketSymbol,
  Price,
  SlippageBps,
  Subaccount,
  bestTicks,
  fineUsd,
  marketConfig,
  openPosition,
  perpTrade,
  requireActivated,
  requireTradable,
  unitsOf,
  usd,
} from './shared'

/**
 * A reduce-only close of an isolated position, built by Phoenix's server. We
 * always pass the price limit: left alone, the server sets one of its own.
 * Its orders carry no slot expiry, so the blockhash limits this one's life.
 */
async function isolatedClose(
  context: TradeContext,
  {
    wallet,
    market,
    subaccount,
    side,
    numBaseLots,
    size,
    limit,
  }: {
    wallet: Address
    market: OrderMarket
    subaccount: number
    side: Side
    numBaseLots: bigint
    size: string
    limit: { maxSlippageBps: number } | { limitPrice: string }
  },
) {
  const units = unitsOf(market)
  const [best, keys] = await Promise.all([
    bestTicks(context, market, side),
    context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
  ])
  if (best === null)
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix's ${market.symbol} book has no ${side === 'buy' ? 'asks' : 'bids'} to fill against`,
    )
  const priceInTicks =
    'limitPrice' in limit
      ? priceToTicks(limit.limitPrice, units, limitRounding(side))
      : slippageLimit(side, best, limit.maxSlippageBps)
  const instructions = await context.orders.placeIsolatedMarketOrder({
    authority: wallet,
    symbol: market.symbol,
    side,
    numBaseLots: Number(numBaseLots),
    isReduceOnly: true,
    maxPriceInTicks: Number(priceInTicks),
    minBaseLotsToFill: Number(MIN_FILL_LOTS),
  })
  await checkPhoenixBundle(instructions, {
    wallet,
    keys,
    market,
    subaccount,
    order: {
      kind: 'market',
      side,
      priceInTicks,
      numBaseLots,
      reduceOnly: true,
    },
  })

  const limitPrice = ticksToPrice(priceInTicks, units)
  const bestPrice = ticksToPrice(best, units)
  const notional = Number(size) * Number(bestPrice)
  const notionalUsd = usd(notional)
  const feeUsd = fineUsd(notional * market.takerFee)
  const outOfReach = side === 'buy' ? priceInTicks < best : priceInTicks > best
  return {
    instructions,
    limitPrice,
    position: {
      symbol: market.symbol,
      assetId: market.assetId,
      baseLotsDecimals: market.baseLotsDecimals,
      subaccount,
    },
    details: {
      side,
      size,
      limitPrice,
      bestPrice,
      estimatedNotionalUsd: notionalUsd,
      estimatedTakerFeeUsd: feeUsd,
      reduceOnly: 'true',
      subaccount: String(subaccount),
    },
    terms: {
      symbol: market.symbol,
      side,
      orderType: 'market' as const,
      size,
      worstPrice: limitPrice,
      bestPrice,
      notionalUsd,
      feeUsd,
      reduceOnly: true,
      marginMode: 'isolated' as const,
      subaccount,
    },
    warnings: [
      'Once the position is fully closed and the subaccount has no resting orders, its collateral returns to your cross-margin account in the same transaction. Until then it stays in the subaccount.',
      ...(outOfReach
        ? [
            `The ${side === 'buy' ? 'limit is below the best ask' : 'limit is above the best bid'} (${bestPrice}), so this order will not fill now.`,
          ]
        : []),
    ],
  }
}

export const closePosition = defineTradeTool({
  name: 'phoenix_close_position',
  title: 'Close a Phoenix position',
  description: [
    'Prepares a close of all or part of the wallet’s position in one Phoenix perps market, cross-margin or isolated.',
    'It is a reduce-only market order on the opposite side, so it can shrink the position but never open or flip one.',
    'It fills now up to a worst price, set by maxSlippageBps or limitPrice (exactly one, no default); whatever cannot fill is cancelled.',
    'Fully closing an isolated position returns its collateral to the cross-margin account in the same transaction.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      subaccount: Subaccount.optional().describe(
        'Subaccount holding the position, from phoenix_get_account: 0 is cross margin, the others isolated. Needed only when the market is open in more than one',
      ),
      fraction: z
        .number()
        .gt(0)
        .lte(1)
        .default(1)
        .describe(
          'Share of the position to close, e.g. 0.5 for half; 1 (default) closes it all',
        ),
      maxSlippageBps: SlippageBps.optional(),
      limitPrice: Price.optional().describe(
        'Worst price in USD: the most a buy pays or the least a sell takes',
      ),
    })
    .strict()
    .refine(
      (input) =>
        (input.maxSlippageBps === undefined) !==
        (input.limitPrice === undefined),
      'Give exactly one of maxSlippageBps or limitPrice',
    ),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const market = await marketConfig(context, input.symbol)
    const [{ subaccount, lots: held }] = await Promise.all([
      openPosition(context, wallet, market.symbol, input.subaccount),
      requireActivated(context, wallet),
    ])
    const isolated = subaccount > 0
    requireTradable(market, isolated ? 'isolated' : 'cross')

    const long = held > 0n
    const side = long ? 'sell' : 'buy'
    const positionLots = long ? held : -held
    const numBaseLots = fractionOfLots(positionLots, input.fraction)
    const decimals = market.baseLotsDecimals
    const size = fromLots(numBaseLots.toString(), decimals)
    const limit = worstPrice(input)
    const direction = long ? 'long' : 'short'
    const positionSize = fromLots(positionLots.toString(), decimals)
    const describe = (limitPrice: string) => {
      const action = long
        ? `market sell now, receiving at least $${limitPrice} each`
        : `market buy now, paying at most $${limitPrice} each`
      const kind = isolated
        ? `isolated ${direction} (subaccount ${subaccount})`
        : direction
      return `Close ${size} of the ${positionSize} ${market.symbol} ${kind}: ${action}; reduce-only, so it can never open a ${long ? 'short' : 'long'}`
    }
    const closing = {
      position: `${direction} ${positionSize}`,
      closing: size,
    }

    if (isolated) {
      const order = await isolatedClose(context, {
        wallet,
        market,
        subaccount,
        side,
        numBaseLots,
        size,
        limit,
      })
      return {
        kind: 'instructions',
        wallet,
        instructions: order.instructions,
        position: order.position,
        summary: describe(order.limitPrice),
        details: { ...order.details, ...closing },
        trade: perpTrade('close', { ...order.terms, closing: direction }),
        warnings: order.warnings,
      }
    }

    const order = await immediateOrder(context, {
      wallet,
      market,
      side,
      numBaseLots,
      size,
      limit,
      reduceOnly: true,
    })
    return {
      kind: 'instructions',
      wallet,
      instructions: [order.instruction],
      expiresAfterSlot: order.expiresAfterSlot,
      position: order.position,
      summary: describe(order.limitPrice),
      details: { ...order.details, ...closing },
      trade: perpTrade('close', { ...order.terms, closing: direction }),
      warnings: order.warnings,
    }
  },
})
