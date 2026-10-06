import { expect, test } from 'bun:test'
import { checkForm, feeNote } from './withdraw-modal'

const wallet = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
const to = '9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N'
const funded = { usdc: 10_000_000n, sol: 100_000_000n }

test('nothing can be sent until the balances have loaded', () => {
  expect(checkForm({ to, amount: '1' }, wallet, null)).toBe('incomplete')
  expect(feeNote(null, false)).toEqual({
    blocked: true,
    text: expect.stringContaining('Checking'),
  })
  expect(feeNote(null, true)).toEqual({
    blocked: true,
    text: expect.stringContaining('could not be loaded'),
  })
  expect(checkForm({ to, amount: '1' }, wallet, funded)).toBeNull()
  expect(feeNote(funded, false).blocked).toBe(false)
})

test('a wallet without SOL is held before it tries to withdraw', () => {
  expect(feeNote({ ...funded, sol: 0n }, false)).toEqual({
    blocked: true,
    text: expect.stringContaining('no SOL'),
  })
})

test('the form names what is wrong with it', () => {
  expect(checkForm({ to: 'nope', amount: '1' }, wallet, funded)).toContain(
    'valid Solana address',
  )
  expect(checkForm({ to: wallet, amount: '1' }, wallet, funded)).toContain(
    'other than this wallet',
  )
  expect(checkForm({ to, amount: '1.1234567' }, wallet, funded)).toContain(
    'six decimals',
  )
  expect(checkForm({ to, amount: '10.01' }, wallet, funded)).toContain(
    'more than the wallet holds',
  )
})
