import { z } from 'zod'
import { PhoenixError } from '../../client'
import { limitRounding, priceToTicks, ticksToPrice } from '../price'
import type { MarketUnits, Side } from '../price'
import type {
  ConditionalPacket,
  ConditionalSlot,
  TriggerPacket,
  TriggerRequest,
} from '../rise'
import { Price } from './shared'

/**
 * TP/SL terms, free of any tool's reads: what an agent gives, what Phoenix's
 * server is asked for, and what `checkPhoenixBundle` holds its answer to.
 */

export const Trigger = z
  .object({
    triggerPrice: Price.describe(
      'USD mark price that fires it, as a decimal string',
    ),
    worstPrice: Price.describe(
      'USD price limit of the order that fires, as a decimal string: the least a sell takes or the most a buy pays. A stop may not fill past it',
    ),
  })
  .strict()
export type Trigger = z.output<typeof Trigger>

export type Direction = 'long' | 'short'
export type TpslLeg = 'takeProfit' | 'stopLoss'

/** The side that closes a position: a trigger never fires the other way. */
export const closingSide = (direction: Direction): Side =>
  direction === 'long' ? 'sell' : 'buy'

/** Which list a leg sits in: a long's TP and a short's SL fire on the way up. */
export const legDirection = (leg: TpslLeg, direction: Direction) =>
  (leg === 'takeProfit') === (direction === 'long') ? 'greater' : 'less'

/** Always shown in a review that sets TP/SL. */
export const TPSL_NOTICES = [
  'Triggers use mark price.',
  'A stop may not fill past its worst price.',
  'Phoenix cancels TP/SL if the position flips.',
]

/** Seen in the live run: firing one leg of a pair cancels the other. */
export const PAIRED_LEGS =
  'The take profit and stop loss are one pair: when one fires, Phoenix cancels the other.'

export const LEG_NAMES: Record<TpslLeg, string> = {
  takeProfit: 'take profit',
  stopLoss: 'stop loss',
}

function packet(
  leg: TpslLeg,
  trigger: Trigger,
  direction: Direction,
  units: MarketUnits,
): TriggerPacket {
  const side = closingSide(direction)
  return {
    triggerDirection: legDirection(leg, direction),
    side,
    // As in Rise's buildTakeProfitStopLossTriggerOrders.
    orderKind: leg === 'takeProfit' ? 'limit' : 'ioc',
    triggerPriceInTicks: priceToTicks(trigger.triggerPrice, units, 'nearest'),
    executionPriceInTicks: priceToTicks(
      trigger.worstPrice,
      units,
      limitRounding(side),
    ),
  }
}

/** A stop's worst price lies beyond its trigger, in the direction it fills. */
function checkStop(stop: TriggerPacket, direction: Direction) {
  const wrongSide =
    stop.side === 'sell'
      ? stop.executionPriceInTicks > stop.triggerPriceInTicks
      : stop.executionPriceInTicks < stop.triggerPriceInTicks
  if (wrongSide)
    throw new PhoenixError(
      'invalid_input',
      `stopLoss worstPrice must be ${stop.side === 'sell' ? 'at or below' : 'at or above'} its triggerPrice for a ${direction}`,
    )
}

// Phoenix's routes take JSON numbers; a value past this would change silently.
function wholeNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PhoenixError(
      'invalid_input',
      'price is above what Phoenix accepts',
    )
  return Number(value)
}

function request(leg: TriggerPacket | null): TriggerRequest | null {
  if (!leg) return null
  return {
    side: leg.side,
    orderKind: leg.orderKind,
    triggerPriceInTicks: wholeNumber(leg.triggerPriceInTicks),
    executionPriceInTicks: wholeNumber(leg.executionPriceInTicks),
  }
}

/**
 * One position's TP/SL as a Rise request (`greaterTrigger`, `lessTrigger`)
 * and as the `ConditionalPacket` the bundle must hold. `direction` is the
 * position's; the size is either a percent or base lots, never both.
 */
export function tpslTerms({
  direction,
  assetId,
  units,
  takeProfit,
  stopLoss,
  size,
}: {
  direction: Direction
  assetId: number
  units: MarketUnits
  takeProfit?: Trigger | undefined
  stopLoss?: Trigger | undefined
  size: Pick<ConditionalPacket, 'sizeBaseLots' | 'sizePercent'>
}) {
  const profit = takeProfit
    ? packet('takeProfit', takeProfit, direction, units)
    : null
  const stop = stopLoss ? packet('stopLoss', stopLoss, direction, units) : null
  if (stop) checkStop(stop, direction)
  const [greater, less] = direction === 'long' ? [profit, stop] : [stop, profit]
  return {
    takeProfit: profit,
    stopLoss: stop,
    greaterTrigger: request(greater),
    lessTrigger: request(less),
    conditional: { assetId, greater, less, ...size },
  }
}

/**
 * Refuses a trigger mark has already passed; Phoenix's program accepts one.
 * The check is in ticks, so a trigger on mark's tick counts as at mark.
 */
export function checkAgainstMark(
  terms: Pick<ReturnType<typeof tpslTerms>, 'takeProfit' | 'stopLoss'>,
  markTicks: bigint,
  direction: Direction,
) {
  for (const leg of ['takeProfit', 'stopLoss'] as const) {
    const trigger = terms[leg]
    if (!trigger) continue
    const above = trigger.triggerDirection === 'greater'
    if (
      above
        ? trigger.triggerPriceInTicks <= markTicks
        : trigger.triggerPriceInTicks >= markTicks
    )
      throw new PhoenixError(
        'invalid_input',
        `A ${direction}'s ${LEG_NAMES[leg]} must trigger ${above ? 'above' : 'below'} the mark price`,
      )
  }
}

/** A leg as the review shows it. */
export const describeLeg = (leg: TriggerPacket, units: MarketUnits) =>
  `trigger $${ticksToPrice(leg.triggerPriceInTicks, units)}, worst $${ticksToPrice(leg.executionPriceInTicks, units)}`

/**
 * The slots protecting one position, with each slot's legs named by what they
 * do for it. A leg that does not close this position was left by an earlier
 * one, so it is not this position's TP/SL.
 */
export function positionLegs(
  slots: readonly ConditionalSlot[],
  assetId: number,
  direction: Direction,
) {
  const side = closingSide(direction)
  const live = (leg: TriggerPacket | null) => (leg?.side === side ? leg : null)
  return slots
    .filter((slot) => slot.assetId === assetId)
    .map((slot) => {
      const [takeProfit, stopLoss] =
        direction === 'long'
          ? [live(slot.greater), live(slot.less)]
          : [live(slot.less), live(slot.greater)]
      return { ...slot, takeProfit, stopLoss }
    })
    .filter((slot) => slot.takeProfit !== null || slot.stopLoss !== null)
}
