import { address } from '@solana/kit'
import { z } from 'zod'
import { Wallet } from '../../tool'
import { checkOrder } from '../checks'
import { limitRounding, priceToTicks, ticksToPrice, toBaseLots } from '../price'
import type { MarketUnits } from '../price'
import { limitOrderInstruction } from '../rise'
import { ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import {
  MarketSymbol,
  OrderSide,
  Price,
  Size,
  bestPrice,
  requireActivated,
  tradableMarket,
} from './shared'

export const limitOrder = defineTradeTool({
  name: 'phoenix_limit_order',
  title: 'Place a Phoenix limit order',
  description: [
    'Prepares a limit buy or sell on a Phoenix perps market, from the wallet’s cross-margin account.',
    'The order rests on the book at its price until it fills or is cancelled; it does not expire.',
    'With postOnly it never takes liquidity: if it would fill at once, Phoenix rejects it.',
    'Size is in tokens. Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  input: z
    .object({
      wallet: Wallet,
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
    })
    .strict(),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const [market] = await Promise.all([
      tradableMarket(context, input.symbol),
      requireActivated(context, wallet),
    ])
    const units: MarketUnits = {
      tickSize: market.tickSize,
      baseLotsDecimals: market.baseLotsDecimals,
    }
    const numBaseLots = toBaseLots(input.size, market.baseLotsDecimals)
    const priceInTicks = priceToTicks(
      input.price,
      units,
      limitRounding(input.side),
    )
    const [keys, opposite] = await Promise.all([
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      bestPrice(context, market.symbol, input.side),
    ])
    const order = {
      side: input.side,
      priceInTicks,
      numBaseLots,
      reduceOnly: input.reduceOnly,
    }
    const instruction = await limitOrderInstruction(wallet, keys, market, {
      ...order,
      postOnly: input.postOnly,
    })
    checkOrder(instruction, {
      ...order,
      kind: input.postOnly ? 'post_only' : 'limit',
      minBaseLotsToFill: null,
      lastValidSlot: null,
      slide: false,
      cancelExisting: false,
    })

    const price = ticksToPrice(priceInTicks, units)
    // A buy at or above the best ask (a sell at or below the best bid) fills
    // at once instead of resting.
    const crosses =
      opposite !== null &&
      (input.side === 'buy'
        ? Number(price) >= Number(opposite)
        : Number(price) <= Number(opposite))
    const verb = input.side === 'buy' ? 'buy' : 'sell'
    return {
      kind: 'instructions',
      wallet,
      instructions: [instruction],
      summary: `Place a ${input.postOnly ? 'post-only ' : ''}limit ${verb} of ${input.size} ${market.symbol} at $${price}; it rests on the book until filled or cancelled`,
      details: {
        side: input.side,
        size: input.size,
        price,
        notionalUsd: (Number(input.size) * Number(price)).toFixed(2),
        [input.side === 'buy' ? 'bestAsk' : 'bestBid']: opposite ?? 'none',
        postOnly: String(input.postOnly),
        reduceOnly: String(input.reduceOnly),
      },
      warnings: crosses
        ? [
            input.postOnly
              ? `The price crosses the book (${opposite}), so Phoenix will reject this post-only order.`
              : `The price crosses the book (${opposite}), so this order will fill at once as a taker instead of resting.`,
          ]
        : [],
    }
  },
})
