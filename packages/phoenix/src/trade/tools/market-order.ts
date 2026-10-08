import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { Wallet } from '../../tool'
import { checkOrder } from '../checks'
import {
  limitRounding,
  priceToTicks,
  slippageLimit,
  ticksToPrice,
  toBaseLots,
} from '../price'
import type { Side } from '../price'
import { orderInstruction } from '../rise'
import type { OrderSpec } from '../rise'
import { ExchangeKeys } from '../schemas'
import type { OrderMarket } from '../schemas'
import { defineTradeTool } from '../tool'
import type { TradeContext } from '../tool'
import { rpcTimeout } from '../transaction'
import {
  MarketSymbol,
  OrderSide,
  Price,
  Size,
  SlippageBps,
  bestTicks,
  fineUsd,
  orderVerb,
  requireActivated,
  tradableMarket,
  unitsOf,
  usd,
} from './shared'

/** An immediate-or-cancel order expires this many slots after it is built (D2). */
export const ORDER_EXPIRY_SLOTS = 16n

/**
 * The building blocks of an immediate-or-cancel order, shared with
 * phoenix_close_position: the price limit, expiry, checked instruction,
 * and what it would cost at the best price.
 */
export async function immediateOrder(
  context: TradeContext,
  {
    wallet,
    market,
    side,
    numBaseLots,
    size,
    limit,
    reduceOnly,
  }: {
    wallet: Address
    market: OrderMarket
    side: Side
    numBaseLots: bigint
    size: string
    limit: { maxSlippageBps: number } | { limitPrice: string }
    reduceOnly: boolean
  },
) {
  const units = unitsOf(market)
  const [best, keys, slot] = await Promise.all([
    bestTicks(context, market, side),
    context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
    context.rpc.getSlot({ commitment: 'confirmed' }).send(rpcTimeout()),
  ])
  if (best === null)
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix's ${market.symbol} book has no ${side === 'buy' ? 'asks' : 'bids'} to fill against`,
    )
  const spec: OrderSpec = {
    kind: 'market',
    side,
    priceInTicks:
      'limitPrice' in limit
        ? priceToTicks(limit.limitPrice, units, limitRounding(side))
        : slippageLimit(side, best, limit.maxSlippageBps),
    numBaseLots,
    reduceOnly,
    lastValidSlot: slot + ORDER_EXPIRY_SLOTS,
  }
  const instruction = await orderInstruction(wallet, keys, market, spec)
  checkOrder(instruction, spec)

  const limitPrice = ticksToPrice(spec.priceInTicks, units)
  const bestPrice = ticksToPrice(best, units)
  const notional = Number(size) * Number(bestPrice)
  const outOfReach =
    side === 'buy' ? spec.priceInTicks < best : spec.priceInTicks > best
  return {
    instruction,
    limitPrice,
    details: {
      side,
      size,
      limitPrice,
      bestPrice,
      estimatedNotionalUsd: usd(notional),
      estimatedTakerFeeUsd: fineUsd(notional * market.takerFee),
      expiresAfterSlot: String(spec.lastValidSlot),
      reduceOnly: String(reduceOnly),
    },
    warnings: [
      // D2: about 16 slots of 400 ms.
      `This order expires about 6 seconds after it was prepared (slot ${spec.lastValidSlot}); sign and send it right away, or prepare it again.`,
      ...(outOfReach
        ? [
            `The ${side === 'buy' ? 'limit is below the best ask' : 'limit is above the best bid'} (${bestPrice}), so this order will not fill now.`,
          ]
        : []),
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
    'Prepares a market buy or sell on a Phoenix perps market, from the wallet’s cross-margin account.',
    'It fills now against the book up to a worst price, set by maxSlippageBps or limitPrice (exactly one, no default); whatever cannot fill at that price is cancelled, so partial fills are possible.',
    'Size is in tokens. Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  input: z
    .object({
      wallet: Wallet,
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
    const [market] = await Promise.all([
      tradableMarket(context, input.symbol),
      requireActivated(context, wallet),
    ])
    const numBaseLots = toBaseLots(input.size, market.baseLotsDecimals)
    const order = await immediateOrder(context, {
      wallet,
      market,
      side: input.side,
      numBaseLots,
      size: input.size,
      limit: worstPrice(input),
      reduceOnly: input.reduceOnly,
    })
    const verb = orderVerb(input.side, input.reduceOnly)
    const bound = input.side === 'buy' ? 'paying at most' : 'receiving at least'
    return {
      kind: 'instructions',
      wallet,
      instructions: [order.instruction],
      summary: `Market ${verb}: ${input.size} ${market.symbol} perp now, ${bound} $${order.limitPrice} each; any part that cannot fill at that price is cancelled`,
      details: order.details,
      warnings: order.warnings,
    }
  },
})
