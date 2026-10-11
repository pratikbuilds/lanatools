import { expect, test } from 'bun:test'
import { needsTradeFacts, orderFill, swapReceived } from './trade-facts'
import type { ParsedWalletTransaction } from './wallet-transfers'

const WALLET = 'G7fu2vBDEZ9SYM4agJPshffJQUmyg6UCEEUnxuYRAMuq'
const POOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL = 'So11111111111111111111111111111111111111112'

const tx = (
  overrides: Partial<ParsedWalletTransaction> = {},
): ParsedWalletTransaction => ({
  slot: 1n,
  blockTime: null,
  err: null,
  accountKeys: [WALLET, POOL],
  fee: 5_000n,
  preBalances: [1_000_000_000n, 0n],
  postBalances: [1_000_000_000n - 5_000n, 0n],
  preTokenBalances: [],
  postTokenBalances: [],
  ...overrides,
})

test('a USDC output is the signer’s net token change', () => {
  const swap = tx({
    preTokenBalances: [
      {
        accountIndex: 1,
        mint: USDC,
        owner: WALLET,
        amount: 2_000_000n,
        decimals: 6,
      },
    ],
    postTokenBalances: [
      {
        accountIndex: 1,
        mint: USDC,
        owner: WALLET,
        amount: 12_950_000n,
        decimals: 6,
      },
    ],
  })
  expect(swapReceived(swap, WALLET, USDC)).toEqual({
    mint: USDC,
    amount: '10.95',
  })
})

test('a SOL output arrives unwrapped, and the fee is not taken from it', () => {
  const swap = tx({
    preBalances: [1_000_000_000n, 0n],
    // 9,130,000 lamports in, 5,000 fee out.
    postBalances: [1_000_000_000n + 9_130_000n - 5_000n, 0n],
  })
  expect(swapReceived(swap, WALLET, SOL)).toEqual({
    mint: SOL,
    amount: '0.00913',
  })
  // Nothing of the output mint came in: no fact.
  expect(swapReceived(tx(), WALLET, USDC)).toBeNull()
})

test('an order’s fills are summed at their average price', () => {
  const fills = [
    {
      size: 0.06,
      price: 109.6,
      feeUsdc: 0.0023,
      realizedPnlUsdc: 0,
      signature: 'sig',
    },
    {
      size: 0.04,
      price: 109.7,
      feeUsdc: 0.0015,
      realizedPnlUsdc: 0,
      signature: 'sig',
    },
    {
      size: 1,
      price: 100,
      feeUsdc: 0.03,
      realizedPnlUsdc: 2,
      signature: 'other',
    },
  ]
  expect(orderFill(fills, 'sig')).toEqual({
    size: '0.1',
    price: '109.64',
    feeUsdc: '0.0038',
    realizedPnlUsdc: '0',
  })
  // Not indexed yet.
  expect(orderFill(fills, 'missing')).toBeNull()
})

test('only confirmed swaps and orders without facts need reading', () => {
  const receipt = {
    signature: 's',
    slot: '1',
    commitment: 'confirmed' as const,
  }
  const swap = {
    kind: 'swap' as const,
    venue: 'jupiter' as const,
    pay: { mint: USDC, symbol: 'USDC', amount: '1' },
    receive: { mint: SOL, symbol: 'SOL' },
    maxSlippageBps: 50,
  }
  expect(needsTradeFacts(swap, receipt)).toBe(true)
  expect(
    needsTradeFacts(swap, { ...receipt, received: { mint: SOL, amount: '1' } }),
  ).toBe(false)
  expect(needsTradeFacts(swap, null)).toBe(false)
  const deposit = {
    kind: 'perp' as const,
    venue: 'phoenix' as const,
    action: 'deposit' as const,
  }
  expect(needsTradeFacts(deposit, receipt)).toBe(false)
  expect(needsTradeFacts({ ...deposit, action: 'order' }, receipt)).toBe(true)
})
