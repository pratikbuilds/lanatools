import { expect, test } from 'bun:test'
import { SpendLimit } from './spend-limit'

test('reserves aggregate exposure and holds uncertain payments', () => {
  const limit = new SpendLimit(10n)
  const first = limit.reserve(6n)
  const second = limit.reserve(4n)
  expect(() => limit.reserve(1n)).toThrow('Wallet spending limit exceeded')
  limit.settle(first, 3n)
  expect(limit.remaining).toBe(3n)
  expect(limit.pending).toBe(1)
  limit.settle(second, 4n)
  expect(limit.remaining).toBe(3n)
  const unsigned = limit.reserve(2n)
  limit.releaseUnsigned(unsigned)
  expect(limit.remaining).toBe(3n)
})
