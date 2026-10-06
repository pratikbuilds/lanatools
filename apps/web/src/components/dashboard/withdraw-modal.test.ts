import { expect, test } from 'bun:test'
import { feeNote } from './withdraw-modal'

test('a wallet without SOL is held before it tries to withdraw', () => {
  expect(feeNote(0n)).toEqual({
    blocked: true,
    text: expect.stringContaining('no SOL'),
  })
  expect(feeNote(null).blocked).toBe(false)
  expect(feeNote(100_000_000n).blocked).toBe(false)
})
