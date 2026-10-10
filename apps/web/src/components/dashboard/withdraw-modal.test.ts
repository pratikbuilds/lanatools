import { expect, test } from 'bun:test'
import type { WalletToken } from '@lanatools/contracts'
import { checkForm, feeNote } from './withdraw-modal'

const wallet = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
const to = '9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N'
const token: WalletToken = {
  account: 'account',
  mint: 'mint',
  program: 'program',
  name: 'USD Coin',
  symbol: 'USDC',
  image: null,
  amount: '10000000',
  decimals: 6,
}
const funded = { usdc: 10_000_000n, sol: 100_000_000n, tokens: [token] }

test('nothing can be sent until the balances have loaded', () => {
  expect(checkForm({ to, amount: '1' }, wallet, null, token)).toBe('incomplete')
  expect(feeNote(null, false)).toEqual({
    blocked: true,
    text: expect.stringContaining('Checking'),
  })
  expect(feeNote(null, true)).toEqual({
    blocked: true,
    text: expect.stringContaining('could not be loaded'),
  })
  expect(checkForm({ to, amount: '1' }, wallet, funded, token)).toBeNull()
  expect(feeNote(funded, false).blocked).toBe(false)
})

test('a wallet without SOL is held before it tries to withdraw', () => {
  expect(feeNote({ ...funded, sol: 0n }, false)).toEqual({
    blocked: true,
    text: expect.stringContaining('no SOL'),
  })
})

test('the form names what is wrong with it', () => {
  expect(
    checkForm({ to: 'nope', amount: '1' }, wallet, funded, token),
  ).toContain('valid Solana address')
  expect(
    checkForm({ to: wallet, amount: '1' }, wallet, funded, token),
  ).toContain('other than this wallet')
  expect(
    checkForm({ to, amount: '1.1234567' }, wallet, funded, token),
  ).toContain('6 decimals')
  expect(checkForm({ to, amount: '10.01' }, wallet, funded, token)).toContain(
    'more than the wallet holds',
  )
})

test('the selected token controls balance and precision', () => {
  const other = { ...token, amount: '25', decimals: 0, symbol: 'TEST' }
  expect(checkForm({ to, amount: '25' }, wallet, funded, other)).toBeNull()
  expect(checkForm({ to, amount: '26' }, wallet, funded, other)).toContain(
    'more than',
  )
  expect(checkForm({ to, amount: '0.1' }, wallet, funded, other)).toContain(
    '0 decimals',
  )
  expect(checkForm({ to, amount: '1' }, wallet, funded, null)).toBe(
    'incomplete',
  )
})
