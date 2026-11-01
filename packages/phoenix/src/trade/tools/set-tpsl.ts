import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { AllMarketStats } from '../../schemas'
import { fromLots } from '../../units'
import { conditionalOrders } from '../chain'
import { checkPhoenixBundle } from '../checks'
import { bookTicks, ticksToPrice, toBaseLots } from '../price'
import { traderAccountAddress } from '../rise'
import { ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import {
  MarketSymbol,
  Size,
  Subaccount,
  openPosition,
  perpTrade,
  requireActivated,
  tradableMarket,
  unitsOf,
} from './shared'
import {
  LEG_NAMES,
  TPSL_NOTICES,
  Trigger,
  checkAgainstMark,
  closingSide,
  describeLeg,
  positionLegs,
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
      subaccount: Subaccount.optional(),
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
    // A position on an isolated-only market may hold TP/SL like any other.
    const [market, stats, keys] = await Promise.all([
      tradableMarket(context, input.symbol, 'isolated'),
      context.phoenix.get('/v1/markets/stats/latest', AllMarketStats),
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated(context, wallet),
    ])
    const position = await openPosition(
      context,
      wallet,
      market.symbol,
      input.subaccount,
    )
    const mark = stats.markets.find(
      (each) => each.symbol === market.symbol,
    )?.mark_price
    if (mark === undefined)
      throw new PhoenixError(
        'market_unavailable',
        `Phoenix sent no mark price for ${market.symbol}`,
      )

    const units = unitsOf(market)
    const decimals = market.baseLotsDecimals
    const direction = position.lots > 0n ? 'long' : 'short'
    const held = position.lots > 0n ? position.lots : -position.lots
    const { lots, ...size } = coverage(input, held, decimals)
    const terms = tpslTerms({
      direction,
      assetId: market.assetId,
      units,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      size,
    })
    const markTicks = bookTicks(mark, units)
    checkAgainstMark(terms, markTicks, direction)

    const { subaccount } = position
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
      isIsolated: subaccount !== 0,
      traderSubaccountIndex: subaccount,
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
    const marginMode = subaccount === 0 ? 'cross' : 'isolated'
    return {
      kind: 'instructions',
      wallet,
      instructions,
      summary: `Set ${legs.map((leg) => LEG_NAMES[leg]).join(' and ')} on ${size.sizePercent === null ? tokens : `${size.sizePercent}%`} of the ${fromLots(held.toString(), decimals)} ${market.symbol} ${direction}`,
      details: {
        position: `${direction} ${fromLots(held.toString(), decimals)}`,
        subaccount: String(subaccount),
        marginMode,
        ...(terms.takeProfit
          ? { takeProfit: describeLeg(terms.takeProfit, units) }
          : {}),
        ...(terms.stopLoss
          ? { stopLoss: describeLeg(terms.stopLoss, units) }
          : {}),
        size: covered,
        markPrice: ticksToPrice(markTicks, units),
        activeTpsl: String(active),
      },
      trade: perpTrade('set_tpsl', {
        symbol: market.symbol,
        side: closingSide(direction),
        size: tokens,
        closing: direction,
        marginMode,
        subaccount,
        ...(terms.takeProfit
          ? {
              takeProfitPrice: ticksToPrice(
                terms.takeProfit.triggerPriceInTicks,
                units,
              ),
            }
          : {}),
        ...(terms.stopLoss
          ? {
              stopLossPrice: ticksToPrice(
                terms.stopLoss.triggerPriceInTicks,
                units,
              ),
            }
          : {}),
      }),
      warnings: [
        ...TPSL_NOTICES,
        ...(active > 0
          ? [
              `This position already has ${active} active TP/SL; this one adds to them and replaces none.`,
            ]
          : []),
        ...(slots === null
          ? [
              'This is the first TP/SL on this account, so your wallet pays a small one-time rent in SOL. Treat it as spent.',
            ]
          : []),
        ...(lots < held
          ? [
              "Phoenix's docs only describe a TP/SL closing the whole position, so check the position after this one fires.",
            ]
          : []),
      ],
    }
  },
})
