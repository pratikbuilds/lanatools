import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { checkOrder } from '../checks'
import {
  exactNumber,
  limitRounding,
  priceToTicks,
  slippageLimit,
  ticksToPrice,
  toBaseLots,
} from '../price'
import type { Side } from '../price'
import { MIN_FILL_LOTS, orderInstruction } from '../rise'
import type { OrderSpec } from '../rise'
import { ExchangeKeys } from '../schemas'
import type { OrderMarket } from '../schemas'
import { defineTradeTool } from '../tool'
import type { TradeContext } from '../tool'
import { rpcTimeout } from '../transaction'
import {
  CrossTakesNoCollateral,
  isolatedFunding,
  marginInputs,
  placeIsolated,
} from './isolated'
import {
  MarketSymbol,
  OrderSide,
  Price,
  Size,
  SlippageBps,
  bestTicks,
  fineUsd,
  orderVerb,
  perpTrade,
  requireActivated,
  tradableMarket,
  unitsOf,
  usd,
} from './shared'

/**
 * An immediate-or-cancel order expires this many slots after it is built
 * (D2): about 30 seconds at mainnet's 0.21 s slots, the life of its
 * transaction's blockhash. Its price limit still bounds the fill.
 */
export const ORDER_EXPIRY_SLOTS = 150n

type ImmediateTerms = {
  market: OrderMarket
  side: Side
  size: string
  limit: { maxSlippageBps: number } | { limitPrice: string }
  reduceOnly: boolean
}

/**
 * What every immediate-or-cancel order states, however it is built: the
 * price limit, and what it would cost at the best price.
 */
async function immediateTerms(
  context: TradeContext,
  { market, side, size, limit, reduceOnly }: ImmediateTerms,
) {
  const units = unitsOf(market)
  const best = await bestTicks(context, market, side)
  if (best === null)
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix's ${market.symbol} book has no ${side === 'buy' ? 'asks' : 'bids'} to fill against`,
    )
  const priceInTicks =
    'limitPrice' in limit
      ? priceToTicks(limit.limitPrice, units, limitRounding(side))
      : slippageLimit(side, best, limit.maxSlippageBps)

  const limitPrice = ticksToPrice(priceInTicks, units)
  const bestPrice = ticksToPrice(best, units)
  const notional = Number(size) * Number(bestPrice)
  const outOfReach = side === 'buy' ? priceInTicks < best : priceInTicks > best
  return {
    priceInTicks,
    limitPrice,
    details: {
      side,
      size,
      limitPrice,
      bestPrice,
      estimatedNotionalUsd: usd(notional),
      estimatedTakerFeeUsd: fineUsd(notional * market.takerFee),
    },
    terms: {
      symbol: market.symbol,
      side,
      orderType: 'market' as const,
      size,
      worstPrice: limitPrice,
      bestPrice,
      notionalUsd: usd(notional),
      feeUsd: fineUsd(notional * market.takerFee),
      reduceOnly,
    },
    warnings: outOfReach
      ? [
          `The ${side === 'buy' ? 'limit is below the best ask' : 'limit is above the best bid'} (${bestPrice}), so this order will not fill now.`,
        ]
      : [],
  }
}

/**
 * The building blocks of a cross immediate-or-cancel order, shared with
 * phoenix_close_position: the price limit, expiry, checked instruction,
 * and what it would cost at the best price.
 */
export async function immediateOrder(
  context: TradeContext,
  {
    wallet,
    numBaseLots,
    ...order
  }: ImmediateTerms & { wallet: Address; numBaseLots: bigint },
) {
  const { market, side, reduceOnly } = order
  const [terms, keys, slot] = await Promise.all([
    immediateTerms(context, order),
    context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
    context.rpc.getSlot({ commitment: 'confirmed' }).send(rpcTimeout()),
  ])
  const spec: OrderSpec = {
    kind: 'market',
    side,
    priceInTicks: terms.priceInTicks,
    numBaseLots,
    reduceOnly,
    lastValidSlot: slot + ORDER_EXPIRY_SLOTS,
  }
  const instruction = await orderInstruction(wallet, keys, market, spec)
  checkOrder(instruction, spec)

  return {
    instruction,
    limitPrice: terms.limitPrice,
    expiresAfterSlot: String(spec.lastValidSlot),
    position: {
      symbol: market.symbol,
      assetId: market.assetId,
      baseLotsDecimals: market.baseLotsDecimals,
    },
    details: {
      ...terms.details,
      expiresAfterSlot: String(spec.lastValidSlot),
      reduceOnly: String(reduceOnly),
    },
    terms: terms.terms,
    warnings: [
      // D2: 150 slots of about 0.21 s.
      `This order expires about 30 seconds after it was prepared (slot ${spec.lastValidSlot}); after that it is not sent, and must be prepared again.`,
      ...terms.warnings,
    ],
  }
}

/** The order's worst price, from exactly one of the two inputs (D1). */
export function worstPrice(input: {
  maxSlippageBps?: number | undefined
  limitPrice?: string | undefined
}) {
  if (input.limitPrice !== undefined && input.maxSlippageBps === undefined)
    return { limitPrice: input.limitPrice }
  if (input.maxSlippageBps !== undefined && input.limitPrice === undefined)
    return { maxSlippageBps: input.maxSlippageBps }
  throw new PhoenixError(
    'invalid_input',
    'Give exactly one of maxSlippageBps or limitPrice',
  )
}

export const marketOrder = defineTradeTool({
  name: 'phoenix_market_order',
  title: 'Place a Phoenix market order',
  description: [
    'Prepares a market buy or sell on a Phoenix perps market, in cross margin (the default) or isolated margin.',
    'It fills now against the book up to a worst price, set by maxSlippageBps or limitPrice (exactly one, no default); whatever cannot fill at that price is cancelled, so partial fills are possible.',
    'Isolated-only markets need marginMode isolated. Opening an isolated position needs collateralUsdc or collateralSol moved from cross, and a market with a cross position is refused.',
    'Size is in tokens. Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      side: OrderSide,
      size: Size,
      maxSlippageBps: SlippageBps.optional(),
      limitPrice: Price.optional().describe(
        'Worst price in USD: the most a buy pays or the least a sell takes',
      ),
      reduceOnly: z
        .boolean()
        .default(false)
        .describe('Only reduce an open position, never open or flip one'),
      ...marginInputs,
    })
    .strict()
    .refine(
      (input) =>
        (input.maxSlippageBps === undefined) !==
        (input.limitPrice === undefined),
      'Give exactly one of maxSlippageBps or limitPrice',
    )
    .refine(...CrossTakesNoCollateral),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const [market] = await Promise.all([
      tradableMarket(context, input.symbol, input.marginMode),
      requireActivated(context, wallet),
    ])
    const numBaseLots = toBaseLots(input.size, market.baseLotsDecimals)
    const verb = orderVerb(input.side, input.reduceOnly)
    const bound = input.side === 'buy' ? 'paying at most' : 'receiving at least'
    const limit = worstPrice(input)

    if (input.marginMode === 'isolated') {
      const funding = await isolatedFunding(context, wallet, market, input)
      const [terms, keys] = await Promise.all([
        immediateTerms(context, {
          market,
          side: input.side,
          size: input.size,
          limit,
          reduceOnly: input.reduceOnly,
        }),
        context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      ])
      const placed = await placeIsolated({
        wallet,
        keys,
        market,
        funding,
        order: {
          kind: 'market',
          side: input.side,
          priceInTicks: terms.priceInTicks,
          numBaseLots,
          reduceOnly: input.reduceOnly,
        },
        // Phoenix reads maxPriceInTicks as the worst price on both sides.
        build: () =>
          context.orders.placeIsolatedMarketOrder({
            authority: wallet,
            symbol: market.symbol,
            side: input.side,
            numBaseLots: exactNumber(numBaseLots, 'size'),
            maxPriceInTicks: exactNumber(terms.priceInTicks, 'price'),
            minBaseLotsToFill: Number(MIN_FILL_LOTS),
            ...(input.reduceOnly ? { isReduceOnly: true } : {}),
            ...funding.transfer,
          }),
      })
      return {
        kind: 'instructions',
        wallet,
        instructions: placed.instructions,
        summary: `Isolated market ${verb}: ${input.size} ${market.symbol} perp now, ${bound} $${terms.limitPrice} each; any part that cannot fill at that price is cancelled. ${funding.sentence}`,
        details: {
          ...terms.details,
          reduceOnly: String(input.reduceOnly),
          ...placed.details,
        },
        trade: perpTrade('order', { ...terms.terms, ...placed.terms }),
        warnings: [...placed.warnings, ...terms.warnings],
      }
    }

    const order = await immediateOrder(context, {
      wallet,
      market,
      side: input.side,
      numBaseLots,
      size: input.size,
      limit,
      reduceOnly: input.reduceOnly,
    })
    return {
      kind: 'instructions',
      wallet,
      instructions: [order.instruction],
      expiresAfterSlot: order.expiresAfterSlot,
      position: order.position,
      summary: `Market ${verb}: ${input.size} ${market.symbol} perp now, ${bound} $${order.limitPrice} each; any part that cannot fill at that price is cancelled`,
      details: order.details,
      trade: perpTrade('order', order.terms),
      warnings: order.warnings,
    }
  },
})
