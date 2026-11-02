import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { checkOrder, checkPhoenixBundle } from '../checks'
import {
  exactNumber,
  limitRounding,
  priceToTicks,
  slippageLimit,
  ticksToPrice,
  toBaseLots,
} from '../price'
import type { Side } from '../price'
import { MIN_FILL_LOTS, hasStep, orderInstruction } from '../rise'
import type { OrderSpec } from '../rise'
import { ExchangeKeys } from '../schemas'
import type { OrderMarket, TraderBook } from '../schemas'
import { defineTradeTool } from '../tool'
import type { TradeContext } from '../tool'
import { rpcTimeout } from '../transaction'
import {
  CrossTakesNoCollateral,
  isolatedFunding,
  marginInputs,
  placeIsolated,
} from './isolated'
import type { MarginInput } from './isolated'
import {
  MarketSymbol,
  OrderSide,
  Price,
  Size,
  SlippageBps,
  bestTicks,
  fineUsd,
  markTicks,
  orderVerb,
  perpTrade,
  requireActivated,
  tradableMarket,
  traderBook,
  unitsOf,
  usd,
} from './shared'
import { Trigger, checkAgainstMark, tpslReview, tpslTerms } from './tpsl'

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
    spec,
    keys,
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
  market: OrderMarket,
  book: TraderBook,
  input: {
    side: Side
    takeProfit?: Trigger | undefined
    stopLoss?: Trigger | undefined
  },
) {
  const direction = input.side === 'buy' ? 'long' : 'short'
  const opposite = book.snapshot.subaccounts
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
  const terms = tpslTerms({
    direction,
    assetId: market.assetId,
    units: unitsOf(market),
    takeProfit: input.takeProfit,
    stopLoss: input.stopLoss,
    size: { sizeBaseLots: null, sizePercent: 100 },
  })
  checkAgainstMark(terms, await markTicks(context, market), direction)
  return terms
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

type TpslTerms = ReturnType<typeof tpslTerms> | null

/** A cross market order: Rise's order, plus Phoenix's TP/SL in one transaction. */
async function crossOrder(
  context: TradeContext,
  wallet: Address,
  ordered: ImmediateTerms,
  numBaseLots: bigint,
  tpsl: TpslTerms,
) {
  const order = await immediateOrder(context, {
    ...ordered,
    wallet,
    numBaseLots,
  })
  // One transaction: if the TP/SL fails, the order never lands without it.
  const instructions = [
    order.instruction,
    ...(tpsl
      ? await context.orders.placePositionConditionalOrder({
          authority: wallet,
          traderPdaIndex: 0,
          symbol: ordered.market.symbol,
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
      market: ordered.market,
      subaccount: 0,
      conditional: tpsl.conditional,
      order: order.spec,
    })
  return {
    label: 'Market',
    instructions,
    limitPrice: order.limitPrice,
    funding: null,
    expiry: {
      expiresAfterSlot: order.expiresAfterSlot,
      position: order.position,
    },
    details: order.details,
    terms: order.terms,
    warnings: order.warnings,
  }
}

/** An isolated market order, built by Phoenix's server and checked. */
async function isolatedOrder(
  context: TradeContext,
  wallet: Address,
  ordered: ImmediateTerms,
  {
    input,
    book,
    numBaseLots,
    tpsl,
  }: {
    input: MarginInput & { reduceOnly: boolean }
    book: TraderBook
    numBaseLots: bigint
    tpsl: TpslTerms
  },
) {
  const { market } = ordered
  const funding = isolatedFunding(market, book, input)
  const [terms, keys] = await Promise.all([
    immediateTerms(context, ordered),
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
      side: ordered.side,
      priceInTicks: terms.priceInTicks,
      numBaseLots,
      reduceOnly: ordered.reduceOnly,
      lastValidSlot: null,
    },
    // Phoenix reads maxPriceInTicks as the worst price on both sides.
    build: () =>
      context.orders.placeIsolatedMarketOrder({
        authority: wallet,
        symbol: market.symbol,
        side: ordered.side,
        numBaseLots: exactNumber(numBaseLots, 'size'),
        maxPriceInTicks: exactNumber(terms.priceInTicks, 'price'),
        minBaseLotsToFill: Number(MIN_FILL_LOTS),
        ...(ordered.reduceOnly ? { isReduceOnly: true } : {}),
        ...funding.transfer,
        ...(tpsl
          ? {
              sizePercent: 100,
              ...(tpsl.greaterTrigger
                ? { greaterTrigger: tpsl.greaterTrigger }
                : {}),
              ...(tpsl.lessTrigger ? { lessTrigger: tpsl.lessTrigger } : {}),
            }
          : {}),
      }),
  })
  return {
    label: 'Isolated market',
    instructions: placed.instructions,
    limitPrice: terms.limitPrice,
    funding: funding.sentence,
    expiry: {},
    details: {
      ...terms.details,
      reduceOnly: String(ordered.reduceOnly),
      ...placed.details,
    },
    terms: { ...terms.terms, ...placed.terms },
    warnings: [...placed.warnings, ...terms.warnings],
  }
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
    const isolated = input.marginMode === 'isolated'
    const wantsTpsl = Boolean(input.takeProfit || input.stopLoss)
    const book =
      isolated || wantsTpsl ? await traderBook(context, wallet) : null
    const tpsl =
      book && wantsTpsl ? await entryTpsl(context, market, book, input) : null
    const ordered = {
      market,
      side: input.side,
      size: input.size,
      limit: worstPrice(input),
      reduceOnly: input.reduceOnly,
    }

    const built =
      book && isolated
        ? await isolatedOrder(context, wallet, ordered, {
            input,
            book,
            numBaseLots,
            tpsl,
          })
        : await crossOrder(context, wallet, ordered, numBaseLots, tpsl)
    const review =
      tpsl &&
      tpslReview(
        tpsl,
        unitsOf(market),
        hasStep(built.instructions, 'create_conditional'),
      )
    const bound = input.side === 'buy' ? 'paying at most' : 'receiving at least'
    return {
      kind: 'instructions',
      wallet,
      instructions: built.instructions,
      ...built.expiry,
      summary: `${built.label} ${orderVerb(input.side, input.reduceOnly)}: ${input.size} ${market.symbol} perp now, ${bound} $${built.limitPrice} each; any part that cannot fill at that price is cancelled${built.funding ? `. ${built.funding}` : ''}`,
      details: { ...built.details, ...review?.details },
      trade: perpTrade('order', { ...built.terms, ...review?.terms }),
      warnings: [...built.warnings, ...(review?.warnings ?? [])],
    }
  },
})
