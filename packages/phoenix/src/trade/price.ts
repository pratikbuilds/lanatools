import { PhoenixError } from '../client'
import { QUOTE_LOTS_DECIMALS, fromLots } from '../units'

/**
 * Exact conversions between what an agent types (tokens, USD, USDC) and what
 * Phoenix encodes (base lots, ticks, USDC base units). Everything is BigInt:
 * a float here would size or price an order wrongly.
 */

/** A market's grid, from Phoenix's market config. */
export type MarketUnits = {
  /** Quote lots per base lot per tick (SOL: 100). */
  tickSize: bigint
  /** Base lots decimals; negative for markets like kBONK (one lot = 100). */
  baseLotsDecimals: number
}

export type Side = 'buy' | 'sell'
export type Rounding = 'down' | 'up' | 'nearest'

type Fraction = { numerator: bigint; denominator: bigint }

const MICRO_USD = 10n ** BigInt(QUOTE_LOTS_DECIMALS)
const BPS = 10_000n

/**
 * A buy limit is the most the buyer pays, so it rounds down; a sell limit is
 * the least the seller takes, so it rounds up. Rounding never loosens it.
 */
export const limitRounding = (side: Side): Rounding =>
  side === 'buy' ? 'down' : 'up'

function parseDecimal(value: string, field: string): Fraction {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  const whole = match?.[1]
  if (whole === undefined)
    throw new PhoenixError(
      'invalid_input',
      `${field} must be a decimal number such as 1.5`,
    )
  const fraction = (match?.[2] ?? '').replace(/0+$/, '')
  return {
    numerator: BigInt(whole + fraction),
    denominator: 10n ** BigInt(fraction.length),
  }
}

function divide(numerator: bigint, denominator: bigint, rounding: Rounding) {
  if (rounding === 'nearest')
    return (2n * numerator + denominator) / (2n * denominator)
  const quotient = numerator / denominator
  return rounding === 'up' && numerator % denominator !== 0n
    ? quotient + 1n
    : quotient
}

/** Decimal string for a price Phoenix sent as a float, without exponents. */
export function decimalString(value: number) {
  if (!Number.isFinite(value) || value <= 0)
    throw new PhoenixError('upstream_error', 'Phoenix sent an invalid price')
  return value.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  })
}

/**
 * Base lots for a size in tokens. The size must sit exactly on the lot grid:
 * an order is never resized silently.
 */
export function toBaseLots(size: string, baseLotsDecimals: number) {
  const { numerator, denominator } = parseDecimal(size, 'size')
  const scale = 10n ** BigInt(Math.abs(baseLotsDecimals))
  const [lotsNumerator, lotsDenominator] =
    baseLotsDecimals >= 0
      ? [numerator * scale, denominator]
      : [numerator, denominator * scale]
  const lotSize = fromLots(1, baseLotsDecimals)
  if (lotsNumerator % lotsDenominator !== 0n)
    throw new PhoenixError(
      'invalid_input',
      `size must be a multiple of this market's lot size, ${lotSize}`,
    )
  const lots = lotsNumerator / lotsDenominator
  if (lots < 1n)
    throw new PhoenixError(
      'invalid_input',
      `size must be at least one lot, ${lotSize}`,
    )
  return lots
}

// ticks = price × 10^6 / (tickSize × 10^baseLotsDecimals), as in Rise's
// priceUsdToTicksWithMarketParams, but with the rounding direction chosen.
function toTicks(price: Fraction, market: MarketUnits, rounding: Rounding) {
  if (market.tickSize <= 0n)
    throw new PhoenixError(
      'upstream_error',
      'Phoenix sent an invalid tick size',
    )
  const scale = 10n ** BigInt(Math.abs(market.baseLotsDecimals))
  let numerator = price.numerator * MICRO_USD
  let denominator = price.denominator * market.tickSize
  if (market.baseLotsDecimals >= 0) denominator *= scale
  else numerator *= scale
  const ticks = divide(numerator, denominator, rounding)
  if (ticks < 1n)
    throw new PhoenixError(
      'invalid_input',
      'price is below the smallest price this market accepts',
    )
  return ticks
}

/**
 * The exact USD price of a tick count:
 * ticks × tickSize × 10^baseLotsDecimals / 10^6.
 */
export function ticksToPrice(ticks: bigint, market: MarketUnits) {
  return fromLots(
    (ticks * market.tickSize).toString(),
    QUOTE_LOTS_DECIMALS - market.baseLotsDecimals,
  )
}

/** Ticks for a USD price the caller gave. */
export function priceToTicks(
  price: string,
  market: MarketUnits,
  rounding: Rounding,
) {
  return toTicks(parseDecimal(price, 'price'), market, rounding)
}

/**
 * The tick of a price level Phoenix's book sent as a float. Levels sit on
 * the tick grid; the float adds noise (115.17999999999999 for 115.18), so
 * the nearest tick is the level's own.
 */
export function bookTicks(price: number, market: MarketUnits) {
  return toTicks(
    parseDecimal(decimalString(price), 'book price'),
    market,
    'nearest',
  )
}

/**
 * The limit for a market order `slippageBps` away from the best price on the
 * other side of the book, in ticks: above the best ask for a buy (rounded
 * down), below the best bid for a sell (rounded up).
 */
export function slippageLimit(
  side: Side,
  bestTicks: bigint,
  slippageBps: number,
) {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10_000
  )
    throw new PhoenixError(
      'invalid_input',
      'maxSlippageBps must be a whole number from 0 to 9999',
    )
  const bps = BigInt(slippageBps)
  // A sell rounds up, so its limit stays at least one tick.
  return divide(
    bestTicks * (side === 'buy' ? BPS + bps : BPS - bps),
    BPS,
    limitRounding(side),
  )
}

/** USDC base units (6 decimals) for an amount such as "12.5". */
export function toUSDCUnits(amount: string) {
  const { numerator, denominator } = parseDecimal(amount, 'amount')
  if (denominator > MICRO_USD)
    throw new PhoenixError(
      'invalid_input',
      'amount must have at most 6 decimals',
    )
  const units = numerator * (MICRO_USD / denominator)
  if (units < 1n)
    throw new PhoenixError('invalid_input', 'amount must be more than 0')
  return units
}
