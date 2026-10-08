import { priceUsdToTicksWithMarketParams } from '@ellipsis-labs/rise'
import { expect, test } from 'bun:test'
import {
  decimalString,
  limitRounding,
  priceToTicks,
  slippageToTicks,
  toBaseLots,
  toUSDCUnits,
} from './price'

// Live market configs from perp-api.phoenix.trade, 2026-10-08.
const SOL = { tickSize: 100n, baseLotsDecimals: 2 }
const KBONK = { tickSize: 100n, baseLotsDecimals: -2 }

test('sizes become base lots only when they sit on the lot grid', () => {
  expect(toBaseLots('0.1', 2)).toBe(10n)
  expect(toBaseLots('12.30', 2)).toBe(1230n)
  expect(toBaseLots('300', -2)).toBe(3n)
  expect(() => toBaseLots('0.015', 2)).toThrow(
    "size must be a multiple of this market's lot size, 0.01",
  )
  expect(() => toBaseLots('250', -2)).toThrow('lot size, 100')
  expect(() => toBaseLots('0', 2)).toThrow('at least one lot, 0.01')
  for (const bad of ['-1', '1e3', '', '.5', 'one'])
    expect(() => toBaseLots(bad, 2)).toThrow('decimal number')
})

test('prices become ticks rounded in the direction asked', () => {
  // The spike's Rise packet priced a $130 SOL limit at 13000 ticks.
  expect(priceToTicks('130', SOL, 'down')).toBe(13000n)
  expect(priceToTicks('130.005', SOL, 'down')).toBe(13000n)
  expect(priceToTicks('130.005', SOL, 'up')).toBe(13001n)
  expect(priceToTicks('0.003498', KBONK, 'down')).toBe(3498n)
  expect(() => priceToTicks('0.001', SOL, 'down')).toThrow(
    'below the smallest price',
  )
})

test('rounding down matches Rise, so only the direction differs', () => {
  for (const [price, market] of [
    ['115.16', SOL],
    ['98765.4321', SOL],
    ['0.0034987', KBONK],
  ] as const)
    expect(priceToTicks(price, market, 'down')).toBe(
      BigInt(priceUsdToTicksWithMarketParams(price, market)),
    )
})

test('a limit never loosens when rounded', () => {
  expect(limitRounding('buy')).toBe('down')
  expect(limitRounding('sell')).toBe('up')
})

test('slippage sets the limit away from the best price on the other side', () => {
  // 115.16 × 1.005 = 115.7358, rounded down for a buy.
  expect(slippageToTicks('buy', '115.16', 50, SOL)).toBe(11573n)
  // 115.16 × 0.995 = 114.5842, rounded up for a sell.
  expect(slippageToTicks('sell', '115.16', 50, SOL)).toBe(11459n)
  expect(slippageToTicks('buy', '115.16', 0, SOL)).toBe(11516n)
  for (const bps of [-1, 1.5, 10_000])
    expect(() => slippageToTicks('buy', '115.16', bps, SOL)).toThrow(
      'maxSlippageBps must be a whole number from 0 to 9999',
    )
})

test('USDC amounts become 6-decimal base units', () => {
  expect(toUSDCUnits('12.5')).toBe(12_500_000n)
  expect(toUSDCUnits('1.0000000')).toBe(1_000_000n)
  expect(toUSDCUnits('0.000001')).toBe(1n)
  expect(() => toUSDCUnits('0.0000001')).toThrow('at most 6 decimals')
  expect(() => toUSDCUnits('0')).toThrow('more than 0')
})

test('float prices from Phoenix become decimal strings without exponents', () => {
  expect(decimalString(115.17999999999999)).toBe('115.17999999999999')
  expect(decimalString(1e-7)).toBe('0.0000001')
  expect(() => decimalString(0)).toThrow('invalid price')
  expect(() => decimalString(Number.NaN)).toThrow('invalid price')
})
