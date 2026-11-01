import { address } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { AllMarketStats } from '../../schemas'
import { checkOrder, checkPhoenixBundle } from '../checks'
import {
  bookTicks,
  exactNumber,
  limitRounding,
  priceToTicks,
  slippageLimit,
  ticksToPrice,
  toBaseLots,
} from '../price'
import type { MarketUnits, Side } from '../price'
import { MIN_FILL_LOTS, decodeBundleStep, orderInstruction } from '../rise'
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
  traderBook,
  unitsOf,
  usd,
} from './shared'
import {
  TPSL_NOTICES,
  Trigger,
  checkAgainstMark,
  describeLeg,
  tpslTerms,
} from './tpsl'

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
    subaccount = 0,
    ...order
  }: ImmediateTerms & {
    wallet: Address
    numBaseLots: bigint
    subaccount?: number
  },
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
  const instruction = await orderInstruction(
    wallet,
    keys,
    market,
    spec,
    subaccount,
  )
  checkOrder(instruction, spec)

  return {
    instruction,
    keys,
    priceInTicks: terms.priceInTicks,
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

/**
 * TP/SL set with an order. It covers the whole position: Phoenix's isolated
 * entry route takes nothing less, and a partial TP/SL goes through
 * phoenix_set_tpsl. Refused when the order would shrink an opposite position:
 * Phoenix only holds a trigger against the position's own direction.
 */
async function entryTpsl(
  context: TradeContext,
  wallet: Address,
  market: OrderMarket,
  input: {
    side: Side
    takeProfit?: Trigger | undefined
    stopLoss?: Trigger | undefined
  },
) {
  if (!input.takeProfit && !input.stopLoss) return null
  const [stats, { snapshot }] = await Promise.all([
    context.phoenix.get('/v1/markets/stats/latest', AllMarketStats),
    traderBook(context, wallet),
  ])
  const mark = stats.markets.find(
    (each) => each.symbol === market.symbol,
  )?.mark_price
  if (mark === undefined)
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix sent no mark price for ${market.symbol}`,
    )
  const direction = input.side === 'buy' ? 'long' : 'short'
  const opposite = snapshot.subaccounts
    .flatMap((account) => account.positions)
    .filter((position) => position.symbol === market.symbol)
    .some((position) =>
      direction === 'long'
        ? BigInt(position.basePositionLots) < 0n
        : BigInt(position.basePositionLots) > 0n,
    )
  if (opposite)
    throw new PhoenixError(
      'invalid_input',
      `This order reduces an open ${market.symbol} position, so it cannot set TP/SL; use phoenix_set_tpsl on the position`,
    )
  const units = unitsOf(market)
  const terms = tpslTerms({
    direction,
    assetId: market.assetId,
    units,
    takeProfit: input.takeProfit,
    stopLoss: input.stopLoss,
    size: { sizeBaseLots: null, sizePercent: 100 },
  })
  checkAgainstMark(terms, bookTicks(mark, units), direction)
  return terms
}

/** What TP/SL adds to an order's result. */
function tpslResult(
  terms: NonNullable<Awaited<ReturnType<typeof entryTpsl>>>,
  units: MarketUnits,
  instructions: readonly Instruction[],
) {
  const creates = instructions.some(
    ({ data }) =>
      decodeBundleStep(Uint8Array.from(data ?? []))?.kind ===
      'create_conditional',
  )
  const { takeProfit, stopLoss } = terms
  return {
    details: {
      ...(takeProfit ? { takeProfit: describeLeg(takeProfit, units) } : {}),
      ...(stopLoss ? { stopLoss: describeLeg(stopLoss, units) } : {}),
    },
    terms: {
      ...(takeProfit
        ? {
            takeProfitPrice: ticksToPrice(
              takeProfit.triggerPriceInTicks,
              units,
            ),
          }
        : {}),
      ...(stopLoss
        ? { stopLossPrice: ticksToPrice(stopLoss.triggerPriceInTicks, units) }
        : {}),
    },
    warnings: [
      ...TPSL_NOTICES,
      ...(creates
        ? [
            'This is the first TP/SL on this account, so your wallet pays a small one-time rent in SOL. Treat it as spent.',
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
      takeProfit: Trigger.optional().describe(
        'Take profit on the whole position, set with this order',
      ),
      stopLoss: Trigger.optional().describe(
        'Stop loss on the whole position, set with this order',
      ),
    })
    .strict()
    .refine(
      (input) =>
        (input.maxSlippageBps === undefined) !==
        (input.limitPrice === undefined),
      'Give exactly one of maxSlippageBps or limitPrice',
    )
    .refine(...CrossTakesNoCollateral)
    .refine(
      (input) => !input.reduceOnly || (!input.takeProfit && !input.stopLoss),
      'A reduce-only order cannot set TP/SL',
    ),
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
    const tpsl = await entryTpsl(context, wallet, market, input)
    const units = unitsOf(market)

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
        conditional: tpsl?.conditional,
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
            ...(tpsl
              ? {
                  sizePercent: 100,
                  ...(tpsl.greaterTrigger
                    ? { greaterTrigger: tpsl.greaterTrigger }
                    : {}),
                  ...(tpsl.lessTrigger
                    ? { lessTrigger: tpsl.lessTrigger }
                    : {}),
                }
              : {}),
          }),
      })
      const added = tpsl && tpslResult(tpsl, units, placed.instructions)
      return {
        kind: 'instructions',
        wallet,
        instructions: placed.instructions,
        summary: `Isolated market ${verb}: ${input.size} ${market.symbol} perp now, ${bound} $${terms.limitPrice} each; any part that cannot fill at that price is cancelled. ${funding.sentence}`,
        details: {
          ...terms.details,
          reduceOnly: String(input.reduceOnly),
          ...placed.details,
          ...added?.details,
        },
        trade: perpTrade('order', {
          ...terms.terms,
          ...placed.terms,
          ...added?.terms,
        }),
        warnings: [
          ...placed.warnings,
          ...terms.warnings,
          ...(added?.warnings ?? []),
        ],
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
    // One transaction: if the TP/SL fails, the order never lands without it.
    const instructions = [
      order.instruction,
      ...(tpsl
        ? await context.orders.placePositionConditionalOrder({
            authority: wallet,
            traderPdaIndex: 0,
            symbol: market.symbol,
            sizePercent: 100,
            greaterTrigger: tpsl.greaterTrigger,
            lessTrigger: tpsl.lessTrigger,
          })
        : []),
    ]
    if (tpsl)
      await checkPhoenixBundle(instructions, {
        wallet,
        keys: order.keys,
        market,
        subaccount: 0,
        conditional: tpsl.conditional,
        order: {
          kind: 'market',
          side: input.side,
          priceInTicks: order.priceInTicks,
          numBaseLots,
          reduceOnly: false,
        },
      })
    const added = tpsl && tpslResult(tpsl, units, instructions)
    return {
      kind: 'instructions',
      wallet,
      instructions,
      expiresAfterSlot: order.expiresAfterSlot,
      position: order.position,
      summary: `Market ${verb}: ${input.size} ${market.symbol} perp now, ${bound} $${order.limitPrice} each; any part that cannot fill at that price is cancelled`,
      details: { ...order.details, ...added?.details },
      trade: perpTrade('order', { ...order.terms, ...added?.terms }),
      warnings: [...order.warnings, ...(added?.warnings ?? [])],
    }
  },
})
