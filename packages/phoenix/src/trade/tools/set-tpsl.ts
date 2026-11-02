import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots } from '../../units'
import { conditionalOrders } from '../chain'
import { checkPhoenixBundle } from '../checks'
import { ticksToPrice, toBaseLots } from '../price'
import { traderAccountAddress } from '../rise'
import { ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import {
  MarketSymbol,
  PositionSubaccount,
  Size,
  marginOf,
  markTicks,
  marketConfig,
  openPosition,
  perpTrade,
  requireActivated,
  subaccountRequest,
  unitsOf,
} from './shared'
import {
  LEG_NAMES,
  Trigger,
  checkAgainstMark,
  closingSide,
  positionLegs,
  tpslReview,
  tpslTerms,
} from './tpsl'

/** How much of the position the TP/SL covers, in Phoenix's terms. */
function coverage(
  input: { percent?: number | undefined; size?: string | undefined },
  held: bigint,
  baseLotsDecimals: number,
) {
  if (input.size !== undefined) {
    const lots = toBaseLots(input.size, baseLotsDecimals)
    if (lots > held)
      throw new PhoenixError(
        'invalid_input',
        `size ${input.size} is more than the ${fromLots(held.toString(), baseLotsDecimals)} position`,
      )
    return { sizeBaseLots: lots, sizePercent: null, lots }
  }
  if (input.percent === undefined)
    throw new PhoenixError(
      'invalid_input',
      'Give exactly one of percent or size',
    )
  const lots = (held * BigInt(input.percent)) / 100n
  // Below one lot Phoenix accepts it, but it may close nothing when it fires.
  if (lots < 1n)
    throw new PhoenixError(
      'invalid_input',
      `${input.percent}% of this position is less than one lot; use a larger percent or a size`,
    )
  return { sizeBaseLots: null, sizePercent: input.percent, lots }
}

export const setTpsl = defineTradeTool({
  name: 'phoenix_set_tpsl',
  title: 'Set Phoenix TP/SL',
  description: [
    'Prepares a take profit, a stop loss or both on an open Phoenix perps position, cross or isolated.',
    'Give takeProfit and/or stopLoss, each with a triggerPrice and a worstPrice (no default), and exactly one of percent or size for how much of the position it covers.',
    'Triggers use mark price and must be on the far side of mark. A stop may not fill past its worst price. Phoenix cancels TP/SL if the position flips.',
    'A position can hold several; this adds one and replaces none.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      subaccount: PositionSubaccount,
      takeProfit: Trigger.optional(),
      stopLoss: Trigger.optional(),
      percent: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Percent of the position to cover, 1 to 100'),
      size: Size.optional().describe(
        'Size to cover in tokens, at most the position; it must be a whole number of lots',
      ),
    })
    .strict()
    .refine(
      (input) => input.takeProfit !== undefined || input.stopLoss !== undefined,
      'Give takeProfit, stopLoss or both',
    )
    .refine(
      (input) => (input.percent === undefined) !== (input.size === undefined),
      'Give exactly one of percent or size',
    ),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    // Like phoenix_cancel_tpsl, no market status check: an open position may
    // always change its protection, and the simulation still runs.
    const [market, keys] = await Promise.all([
      marketConfig(context, input.symbol),
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated(context, wallet),
    ])
    const [{ subaccount, direction, held }, mark] = await Promise.all([
      openPosition(context, wallet, market.symbol, input.subaccount),
      markTicks(context, market),
    ])

    const units = unitsOf(market)
    const decimals = market.baseLotsDecimals
    const { lots, ...size } = coverage(input, held, decimals)
    const terms = tpslTerms({
      direction,
      assetId: market.assetId,
      units,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      size,
    })
    checkAgainstMark(terms, mark, direction)

    const slots = await conditionalOrders(
      context.rpc,
      await traderAccountAddress(wallet, subaccount),
    )
    const instructions = await context.orders.placePositionConditionalOrder({
      authority: wallet,
      traderPdaIndex: 0,
      symbol: market.symbol,
      ...(size.sizePercent === null
        ? { numBaseLots: Number(lots) }
        : { sizePercent: size.sizePercent }),
      greaterTrigger: terms.greaterTrigger,
      lessTrigger: terms.lessTrigger,
      ...subaccountRequest(subaccount),
    })
    await checkPhoenixBundle(instructions, {
      wallet,
      keys,
      market,
      subaccount,
      conditional: terms.conditional,
    })

    const active = positionLegs(slots ?? [], market.assetId, direction).length
    const tokens = fromLots(lots.toString(), decimals)
    const covered =
      size.sizePercent === null
        ? `${tokens} ${market.symbol}`
        : `${size.sizePercent}% of the position, about ${tokens} ${market.symbol} now`
    const legs = (['takeProfit', 'stopLoss'] as const).filter(
      (leg) => terms[leg] !== null,
    )
    const review = tpslReview(terms, units, slots === null)
    return {
      kind: 'instructions',
      wallet,
      instructions,
      summary: `Set ${legs.map((leg) => LEG_NAMES[leg]).join(' and ')} on ${size.sizePercent === null ? tokens : `${size.sizePercent}%`} of the ${fromLots(held.toString(), decimals)} ${market.symbol} ${direction}`,
      details: {
        position: `${direction} ${fromLots(held.toString(), decimals)}`,
        ...marginOf(subaccount).details,
        ...review.details,
        size: covered,
        markPrice: ticksToPrice(mark, units),
        activeTpsl: String(active),
      },
      trade: perpTrade('set_tpsl', {
        symbol: market.symbol,
        side: closingSide(direction),
        size: tokens,
        closing: direction,
        ...marginOf(subaccount).terms,
        ...review.terms,
      }),
      warnings: [
        ...review.warnings,
        ...(active > 0
          ? [
              `This position already has ${active} active TP/SL; this one adds to them and replaces none.`,
            ]
          : []),
        ...(lots < held
          ? [
              'When it fires it closes only this share; the rest of the position stays open without this TP/SL.',
            ]
          : []),
      ],
    }
  },
})
