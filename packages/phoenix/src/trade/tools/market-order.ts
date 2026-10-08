import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { Wallet } from '../../tool'
import { checkOrder } from '../checks'
import {
  limitRounding,
  priceToTicks,
  slippageToTicks,
  ticksToPrice,
  toBaseLots,
} from '../price'
import type { MarketUnits, Side } from '../price'
import { MIN_FILL_LOTS, marketOrderInstruction } from '../rise'
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
  bestPrice,
  requireActivated,
  tradableMarket,
} from './shared'

/** An immediate-or-cancel order expires this many slots after it is built (D2). */
export const ORDER_EXPIRY_SLOTS = 16n

const usd = (value: number) => value.toFixed(2)

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
  const units: MarketUnits = {
    tickSize: market.tickSize,
    baseLotsDecimals: market.baseLotsDecimals,
  }
  const [best, keys, slot] = await Promise.all([
    bestPrice(context, market.symbol, side),
    context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
    context.rpc.getSlot({ commitment: 'confirmed' }).send(rpcTimeout()),
  ])
  if (best === null)
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix's ${market.symbol} book has no ${side === 'buy' ? 'asks' : 'bids'} to fill against`,
    )
  const priceInTicks =
    'limitPrice' in limit
      ? priceToTicks(limit.limitPrice, units, limitRounding(side))
      : slippageToTicks(side, best, limit.maxSlippageBps, units)
  const lastValidSlot = slot + ORDER_EXPIRY_SLOTS
  const order = { side, priceInTicks, numBaseLots, reduceOnly }
  const instruction = await marketOrderInstruction(wallet, keys, market, {
    ...order,
    lastValidSlot,
  })
  checkOrder(instruction, {
    ...order,
    kind: 'market',
    minBaseLotsToFill: MIN_FILL_LOTS,
    lastValidSlot,
    slide: false,
    cancelExisting: false,
  })

  const limitPrice = ticksToPrice(priceInTicks, units)
  const notional = Number(size) * Number(best)
  const outOfReach =
    side === 'buy'
      ? Number(limitPrice) < Number(best)
      : Number(limitPrice) > Number(best)
  return {
    instruction,
    limitPrice,
    details: {
      side,
      size,
      limitPrice,
      bestPrice: best,
      estimatedNotionalUsd: usd(notional),
      estimatedTakerFeeUsd: usd(notional * market.takerFee),
      expiresAfterSlot: lastValidSlot.toString(),
      reduceOnly: String(reduceOnly),
    },
    warnings: outOfReach
      ? [
          `The ${side === 'buy' ? 'limit is below the best ask' : 'limit is above the best bid'} (${best}), so this order will not fill now.`,
        ]
      : [],
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
    const verb = input.side === 'buy' ? 'Buy' : 'Sell'
    const bound = input.side === 'buy' ? 'at most' : 'at least'
    return {
      kind: 'instructions',
      wallet,
      instructions: [order.instruction],
      summary: `${verb} ${input.size} ${market.symbol} now at ${bound} $${order.limitPrice} each (market order); any part that cannot fill at that price is cancelled`,
      details: order.details,
      warnings: order.warnings,
    }
  },
})
