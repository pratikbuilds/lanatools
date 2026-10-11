import { expect, test } from 'bun:test'
import type { PerpTrade, SwapTrade } from '@lanatools/contracts'
import {
  formatUSD,
  orderTicket,
  perpNotional,
  swapRate,
  tradeAmounts,
  tradeDetail,
  tradeTitle,
} from './trades'

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const SOL = 'So11111111111111111111111111111111111111112'
const swap: SwapTrade = {
  kind: 'swap',
  venue: 'jupiter',
  pay: { mint: USDC, symbol: 'USDC', amount: '1' },
  receive: {
    mint: SOL,
    symbol: 'SOL',
    estimated: '0.00913',
    minimum: '0.00908',
  },
  maxSlippageBps: 50,
}
const perp = (terms: Omit<PerpTrade, 'kind' | 'venue'>): PerpTrade => ({
  kind: 'perp',
  venue: 'phoenix',
  ...terms,
})
const buy = perp({
  action: 'order',
  symbol: 'SOL',
  side: 'buy',
  orderType: 'market',
  size: '0.1',
  worstPrice: '110.15',
  bestPrice: '109.6',
  notionalUsd: '10.96',
  feeUsd: '0.003836',
  reduceOnly: false,
})

test('a swap reads as what went in and what came back', () => {
  expect(tradeTitle(swap)).toBe('Swap USDC → SOL')
  // Quoted as people quote it: SOL in dollars, whichever way it went.
  expect(swapRate(swap)).toBe('1 SOL ≈ 109.529 USDC')
  expect(tradeDetail(swap, true)).toBe('Jupiter · 1 SOL ≈ 109.529 USDC')
  expect(
    swapRate({
      ...swap,
      pay: { mint: SOL, symbol: 'SOL', amount: '0.1' },
      receive: { mint: USDC, symbol: 'USDC', estimated: '10.95' },
    }),
  ).toBe('1 SOL ≈ 109.5 USDC')
  expect(tradeAmounts(swap)).toEqual({ out: '1 USDC', in: '0.00913 SOL' })
  // Before the quote only the payment is known.
  const unquoted: SwapTrade = { ...swap, receive: { mint: SOL, symbol: 'SOL' } }
  expect(tradeDetail(unquoted, false)).toBe('Jupiter')
  expect(tradeAmounts(unquoted)).toEqual({ out: '1 USDC', in: null })
})

test('a perp order reads as the trade, with its notional and no wallet money', () => {
  expect(tradeTitle(buy)).toBe('Buy 0.1 SOL-PERP')
  expect(tradeDetail(buy, true)).toBe('Phoenix · Market, at most $110.15')
  expect(tradeAmounts(buy)).toEqual({ out: null, in: null })
  expect(perpNotional(buy)).toBe('$10.96')
  const limit = perp({
    action: 'order',
    symbol: 'ETH',
    side: 'sell',
    orderType: 'limit',
    size: '0.5',
    limitPrice: '2590',
    postOnly: true,
  })
  expect(tradeTitle(limit)).toBe('Sell 0.5 ETH-PERP')
  expect(tradeDetail(limit, false)).toBe(
    'Phoenix · Limit at $2,590.00, post only',
  )
})

test('closes, cancels and collateral moves say what they do', () => {
  const close = perp({
    action: 'close',
    symbol: 'SOL',
    side: 'sell',
    size: '1.5',
    closing: 'long',
    worstPrice: '108.9',
  })
  expect(tradeTitle(close)).toBe('Close long 1.5 SOL-PERP')
  expect(tradeDetail(close, true)).toBe(
    'Phoenix · Reduce only, at least $108.90',
  )
  // Before preparation the size is not known yet.
  expect(tradeTitle(perp({ action: 'close', symbol: 'SOL' }))).toBe(
    'Close SOL-PERP',
  )
  expect(
    tradeTitle(perp({ action: 'cancel', symbol: 'SOL', cancelled: 1 })),
  ).toBe('Cancel 1 SOL-PERP order')
  expect(tradeTitle(perp({ action: 'cancel', symbol: 'SOL' }))).toBe(
    'Cancel SOL-PERP orders',
  )
  const deposit = perp({ action: 'deposit', amountUsdc: '250' })
  expect(tradeTitle(deposit)).toBe('Deposit to Phoenix')
  expect(tradeAmounts(deposit)).toEqual({ out: '250 USDC', in: null })
  const withdraw = perp({ action: 'withdraw', amountUsdc: '40' })
  expect(tradeAmounts(withdraw)).toEqual({ out: null, in: '40 USDC' })
  expect(tradeTitle(perp({ action: 'activate' }))).toBe(
    'Activate Phoenix account',
  )
})

test('the order ticket lists only the terms the trade has; its tag shows the side', () => {
  expect(orderTicket(buy)).toEqual([
    ['Market', 'SOL-PERP'],
    ['Type', 'Market, fill or cancel'],
    ['Size', '0.1 SOL'],
    ['Worst price', 'at most $110.15'],
    ['Best price', '$109.60'],
    ['Notional', '$10.96'],
    ['Taker fee', '$0.003836'],
    ['Reduce only', 'No'],
  ])
})

test('USD keeps cents, and sub-cent fees keep their digits', () => {
  expect(formatUSD('1240')).toBe('$1,240.00')
  expect(formatUSD('0.004031')).toBe('$0.004031')
  expect(formatUSD(-0.42)).toBe('−$0.42')
  expect(formatUSD(4.05, { signed: true })).toBe('+$4.05')
})

test('once read after confirmation, actual amounts replace estimates', () => {
  const received = { mint: SOL, amount: '0.009101' }
  expect(tradeAmounts(swap, { received })).toEqual({
    out: '1 USDC',
    in: '0.009101 SOL',
  })
  expect(swapRate(swap, { received })).toBe('1 SOL = 109.878 USDC')
  const fill = {
    size: '0.1',
    price: '109.64',
    feeUsdc: '0.0038',
    realizedPnlUsdc: '0',
  }
  expect(tradeDetail(buy, true, { fill })).toBe('Phoenix · Filled at $109.64')
  expect(perpNotional(buy, { fill })).toBe('$10.96')
  expect(orderTicket(buy, { fill })).toEqual([
    ['Market', 'SOL-PERP'],
    ['Type', 'Market, fill or cancel'],
    ['Size', '0.1 SOL'],
    ['Worst price', 'at most $110.15'],
    ['Filled', '0.1 SOL'],
    ['Fill price', '$109.64'],
    ['Notional', '$10.96'],
    ['Fee paid', '$0.0038'],
    ['Reduce only', 'No'],
  ])
  const close = perp({ action: 'close', symbol: 'SOL', side: 'sell' })
  expect(
    tradeDetail(close, true, { fill: { ...fill, realizedPnlUsdc: '4.05' } }),
  ).toBe('Phoenix · Filled at $109.64, realized +$4.05')
})
