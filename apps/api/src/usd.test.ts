import { expect, test } from 'bun:test'
import { formatUsd, parseUsd } from '@lanatools/contracts'

test('parseUsd reads dollars into exact micro-USD', () => {
  expect(parseUsd('0.01')).toBe(10_000)
  expect(parseUsd('$5')).toBe(5_000_000)
  expect(parseUsd('1.000001')).toBe(1_000_001)
  expect(parseUsd(' 12.5 ')).toBe(12_500_000)
})

test('parseUsd refuses malformed or over-precise amounts', () => {
  for (const value of ['', '-1', '1.0000001', '1e3', 'abc', '.5', '1.'])
    expect(parseUsd(value)).toBeNull()
})

test('formatUsd keeps cents and sub-cent digits', () => {
  expect(formatUsd(0)).toBe('$0.00')
  expect(formatUsd(10_000)).toBe('$0.01')
  expect(formatUsd(1_500_000)).toBe('$1.50')
  expect(formatUsd(1_234)).toBe('$0.001234')
  expect(formatUsd(1_000_000_000)).toBe('$1,000.00')
})
