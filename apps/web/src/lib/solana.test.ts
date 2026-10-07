import { expect, test } from 'bun:test'
import { formatSol, formatUnits } from './solana'

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

test('SOL is shown to four decimals, never as zero when there is some', () => {
  expect(formatSol(100_000_000n)).toBe('0.1')
  expect(formatSol(1_234_567_890n)).toBe('1.2345')
  expect(formatSol(0n)).toBe('0')
  expect(formatSol(50_000n)).toBe('<0.0001')
})
