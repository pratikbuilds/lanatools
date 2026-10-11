import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots } from '../../units'
import { fractionOfLots } from '../price'
import { defineTradeTool } from '../tool'
import { immediateOrder, worstPrice } from './market-order'
import {
  MarketSymbol,
  Price,
  SlippageBps,
  crossAccount,
  perpTrade,
  requireActivated,
  tradableMarket,
} from './shared'

export const closePosition = defineTradeTool({
  name: 'phoenix_close_position',
  title: 'Close a Phoenix position',
  description: [
    'Prepares a close of all or part of the wallet’s position in one Phoenix perps market (cross-margin account).',
    'It is a reduce-only market order on the opposite side, so it can shrink the position but never open or flip one.',
    'It fills now up to a worst price, set by maxSlippageBps or limitPrice (exactly one, no default); whatever cannot fill is cancelled.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
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
    const [market, account] = await Promise.all([
      tradableMarket(context, input.symbol),
      crossAccount(context, wallet),
      requireActivated(context, wallet),
    ])
    const held = BigInt(
      account.positions.find((position) => position.symbol === market.symbol)
        ?.basePositionLots ?? 0,
    )
    if (held === 0n)
      throw new PhoenixError(
        'not_found',
        `This account has no open ${market.symbol} position`,
      )

    const long = held > 0n
    const positionLots = long ? held : -held
    const numBaseLots = fractionOfLots(positionLots, input.fraction)
    const decimals = market.baseLotsDecimals
    const size = fromLots(numBaseLots.toString(), decimals)
    const order = await immediateOrder(context, {
      wallet,
      market,
      side: long ? 'sell' : 'buy',
      numBaseLots,
      size,
      limit: worstPrice(input),
      reduceOnly: true,
    })

    const direction = long ? 'long' : 'short'
    const action = long
      ? `market sell now, receiving at least $${order.limitPrice} each`
      : `market buy now, paying at most $${order.limitPrice} each`
    return {
      kind: 'instructions',
      wallet,
      instructions: [order.instruction],
      expiresAfterSlot: order.expiresAfterSlot,
      position: order.position,
      summary: `Close ${size} of the ${fromLots(positionLots.toString(), decimals)} ${market.symbol} ${direction}: ${action}; reduce-only, so it can never open a ${long ? 'short' : 'long'}`,
      details: {
        ...order.details,
        position: `${direction} ${fromLots(positionLots.toString(), decimals)}`,
        closing: size,
      },
      trade: perpTrade('close', { ...order.terms, closing: direction }),
      warnings: order.warnings,
    }
  },
})
