import { expect, test } from 'bun:test'
import { formatUnits } from './solana'

test('formatUnits truncates, trims, and pads token amounts', () => {
  expect(formatUnits(0n, 6, { maxFraction: 2, minFraction: 2 })).toBe('0.00')
  expect(formatUnits(12_345_678n, 6, { maxFraction: 2, minFraction: 2 })).toBe(
    '12.34',
  )
  expect(formatUnits(1_500_000_000n, 9, { maxFraction: 4 })).toBe('1.5')
  expect(formatUnits(5_000n, 9, { maxFraction: 4 })).toBe('0')
  expect(formatUnits(1_234_000_000_000n, 6, { maxFraction: 2 })).toBe(
    '1,234,000',
  )
})
