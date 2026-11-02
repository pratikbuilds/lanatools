import { address } from '@solana/kit'
import { z } from 'zod'
import { fromLots } from '../../units'
import { checkPhoenixBundle } from '../checks'
import { fractionOfLots } from '../price'
import { sweepInstructions } from '../rise'
import { defineTradeTool } from '../tool'
import { immediateOrder, worstPrice } from './market-order'
import {
  MarketSymbol,
  PositionSubaccount,
  Price,
  SlippageBps,
  marginOf,
  marketConfig,
  openPosition,
  perpTrade,
  requireActivated,
} from './shared'

const COLLATERAL_RETURNS =
  'Once the position is fully closed and the subaccount has no resting orders, its collateral returns to your cross-margin account in the same transaction. Until then it stays in the subaccount.'

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
      subaccount: PositionSubaccount,
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
    const [{ subaccount, direction, held }] = await Promise.all([
      openPosition(context, wallet, market.symbol, input.subaccount),
      requireActivated(context, wallet),
    ])
    const isolated = subaccount > 0
    const long = direction === 'long'
    const numBaseLots = fractionOfLots(held, input.fraction)
    const decimals = market.baseLotsDecimals
    const size = fromLots(numBaseLots.toString(), decimals)
    const positionSize = fromLots(held.toString(), decimals)

    const order = await immediateOrder(context, {
      wallet,
      market,
      side: long ? 'sell' : 'buy',
      numBaseLots,
      size,
      limit: worstPrice(input),
      reduceOnly: true,
      subaccount,
    })
    // Rise's own order, not Phoenix's isolated route: that route picks the
    // subaccount itself, so it cannot reach a second position in one market.
    const sweeps = isolated
      ? await sweepInstructions(wallet, order.keys, subaccount)
      : []
    const instructions = [order.instruction, ...sweeps]
    if (isolated)
      await checkPhoenixBundle(instructions, {
        wallet,
        keys: order.keys,
        market,
        subaccount,
        order: order.spec,
      })
    const action = long
      ? `market sell now, receiving at least $${order.limitPrice} each`
      : `market buy now, paying at most $${order.limitPrice} each`
    const kind = isolated
      ? `isolated ${direction} (subaccount ${subaccount})`
      : direction
    return {
      kind: 'instructions',
      wallet,
      instructions,
      expiresAfterSlot: order.expiresAfterSlot,
      position: { ...order.position, subaccount },
      summary: `Close ${size} of the ${positionSize} ${market.symbol} ${kind}: ${action}; reduce-only, so it can never open a ${long ? 'short' : 'long'}`,
      details: {
        ...order.details,
        position: `${direction} ${positionSize}`,
        closing: size,
        ...marginOf(subaccount).details,
      },
      trade: perpTrade('close', {
        ...order.terms,
        closing: direction,
        ...marginOf(subaccount).terms,
      }),
      warnings: [...(isolated ? [COLLATERAL_RETURNS] : []), ...order.warnings],
    }
  },
})
