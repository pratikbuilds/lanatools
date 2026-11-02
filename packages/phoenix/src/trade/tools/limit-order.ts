import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { checkOrder } from '../checks'
import {
  exactNumber,
  limitRounding,
  priceToTicks,
  ticksToPrice,
  toBaseLots,
} from '../price'
import { orderInstruction } from '../rise'
import type { OrderSpec } from '../rise'
import { ExchangeKeys } from '../schemas'
import type { OrderMarket } from '../schemas'
import { defineTradeTool } from '../tool'
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
  bestTicks,
  orderVerb,
  perpTrade,
  requireActivated,
  tradableMarket,
  unitsOf,
  usd,
} from './shared'

async function crossLimit(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
  spec: OrderSpec,
) {
  const instruction = await orderInstruction(wallet, keys, market, spec)
  checkOrder(instruction, spec)
  return {
    instructions: [instruction],
    details: {},
    terms: {},
    warnings: [],
  }
}

export const limitOrder = defineTradeTool({
  name: 'phoenix_limit_order',
  title: 'Place a Phoenix limit order',
  description: [
    'Prepares a limit buy or sell on a Phoenix perps market, in cross margin (the default) or isolated margin.',
    'The order rests on the book at its price until it fills or is cancelled; it does not expire.',
    'With postOnly it never takes liquidity: if it would fill at once, Phoenix rejects it.',
    'Isolated-only markets need marginMode isolated. Opening an isolated position needs collateralUsdc or collateralSol moved from cross, and a market with a cross position is refused.',
    'Size is in tokens. Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      side: OrderSide,
      size: Size,
      price: Price.describe(
        'Limit price in USD; a buy rounds down and a sell rounds up to the tick',
      ),
      postOnly: z
        .boolean()
        .default(false)
        .describe('Only rest on the book; reject rather than fill at once'),
      reduceOnly: z
        .boolean()
        .default(false)
        .describe('Only reduce an open position, never open or flip one'),
      ...marginInputs,
    })
    .strict()
    .refine(...CrossTakesNoCollateral),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const [market] = await Promise.all([
      tradableMarket(context, input.symbol, input.marginMode),
      requireActivated(context, wallet),
    ])
    const units = unitsOf(market)
    const spec: OrderSpec = {
      kind: input.postOnly ? 'post_only' : 'limit',
      side: input.side,
      priceInTicks: priceToTicks(input.price, units, limitRounding(input.side)),
      numBaseLots: toBaseLots(input.size, market.baseLotsDecimals),
      reduceOnly: input.reduceOnly,
      lastValidSlot: null,
    }
    const funding =
      input.marginMode === 'isolated'
        ? await isolatedFunding(context, wallet, market, input)
        : null
    const [keys, opposite] = await Promise.all([
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      bestTicks(context, market, input.side),
    ])
    const placed = funding
      ? await placeIsolated({
          wallet,
          keys,
          market,
          funding,
          order: spec,
          build: () =>
            context.orders.placeIsolatedLimitOrder({
              authority: wallet,
              symbol: market.symbol,
              side: input.side,
              numBaseLots: exactNumber(spec.numBaseLots, 'size'),
              priceInTicks: exactNumber(spec.priceInTicks, 'price'),
              isPostOnly: input.postOnly,
              isReduceOnly: input.reduceOnly,
              ...funding.transfer,
            }),
        })
      : await crossLimit(wallet, keys, market, spec)

    const price = ticksToPrice(spec.priceInTicks, units)
    const oppositePrice =
      opposite === null ? 'none' : ticksToPrice(opposite, units)
    // A buy at or above the best ask (a sell at or below the best bid) fills
    // at once instead of resting.
    const crosses =
      opposite !== null &&
      (input.side === 'buy'
        ? spec.priceInTicks >= opposite
        : spec.priceInTicks <= opposite)
    const order = `${orderVerb(input.side, input.reduceOnly)}: ${input.size} ${market.symbol} perp at $${price}; it rests on the book until filled or cancelled`
    return {
      kind: 'instructions',
      wallet,
      instructions: placed.instructions,
      summary: funding
        ? `Isolated ${input.postOnly ? 'post-only limit' : 'limit'} ${order}. ${funding.sentence}`
        : `${input.postOnly ? 'Post-only limit' : 'Limit'} ${order}`,
      details: {
        side: input.side,
        size: input.size,
        price,
        notionalUsd: usd(Number(input.size) * Number(price)),
        [input.side === 'buy' ? 'bestAsk' : 'bestBid']: oppositePrice,
        postOnly: String(input.postOnly),
        reduceOnly: String(input.reduceOnly),
        ...placed.details,
      },
      trade: perpTrade('order', {
        symbol: market.symbol,
        side: input.side,
        orderType: 'limit',
        size: input.size,
        limitPrice: price,
        ...(opposite === null ? {} : { bestPrice: oppositePrice }),
        notionalUsd: usd(Number(input.size) * Number(price)),
        postOnly: input.postOnly,
        reduceOnly: input.reduceOnly,
        ...placed.terms,
      }),
      warnings: [
        ...placed.warnings,
        ...(crosses
          ? [
              input.postOnly
                ? `The price crosses the book (${oppositePrice}), so Phoenix will reject this post-only order.`
                : `The price crosses the book (${oppositePrice}), so this order will fill at once as a taker instead of resting.`,
            ]
          : []),
      ],
    }
  },
})
