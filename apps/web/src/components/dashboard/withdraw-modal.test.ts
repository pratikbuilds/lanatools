import { expect, test } from 'bun:test'
import { feeNote } from './withdraw-modal'

test('a wallet without SOL is told before it tries to withdraw', () => {
  expect(feeNote(0n)).toEqual({
    blocked: true,
    text: expect.stringContaining('no SOL'),
  })
  expect(feeNote(null)).toMatchObject({ blocked: false })
  const funded = feeNote(100_000_000n)
  expect(funded.blocked).toBe(false)
  expect(funded.text).toContain('0.1 SOL')
})
