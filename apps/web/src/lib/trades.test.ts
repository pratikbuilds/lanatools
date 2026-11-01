import { expect, test } from 'bun:test'
import type {
  PerpTrade,
  PhoenixPosition,
  PhoenixTrigger,
  SwapTrade,
} from '@lanatools/contracts'
import {
  fillsInItsOwnTransaction,
  formatPrice,
  formatUSD,
  orderTicket,
  perpNotional,
  swapRate,
  tradeAmounts,
  tradeDetail,
  tradeTitle,
  triggerSummary,
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

test('an isolated order says so in its subtitle', () => {
  const isolated = { ...buy, marginMode: 'isolated' as const }
  expect(tradeDetail(isolated, true)).toBe(
    'Phoenix · Isolated · Market, at most $110.15',
  )
  expect(
    tradeDetail(
      perp({
        action: 'order',
        orderType: 'limit',
        limitPrice: '2590',
        postOnly: true,
        marginMode: 'isolated',
      }),
      true,
    ),
  ).toBe('Phoenix · Isolated · Limit at $2,590.00, post only')
  expect(
    tradeDetail(isolated, true, {
      fill: {
        size: '0.1',
        price: '109.64',
        feeUsdc: '0.0038',
        realizedPnlUsdc: '0',
      },
    }),
  ).toBe('Phoenix · Isolated · Filled at $109.64')
  expect(tradeDetail({ ...buy, marginMode: 'cross' }, true)).toBe(
    'Phoenix · Market, at most $110.15',
  )
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
  const solDeposit = perp({
    action: 'deposit',
    asset: 'SOL',
    amountSol: '0.25',
  })
  expect(tradeTitle(solDeposit)).toBe('Deposit to Phoenix')
  expect(tradeAmounts(solDeposit)).toEqual({ out: '0.25 SOL', in: null })
  expect(
    tradeAmounts(perp({ action: 'withdraw', asset: 'SOL', amountSol: '0.1' })),
  ).toEqual({ out: null, in: '0.1 SOL' })
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

test('prices keep the precision they carry; money stays in cents', () => {
  expect(formatPrice('0.12345')).toBe('$0.12345')
  expect(formatPrice('0.12340')).toBe('$0.1234')
  expect(formatPrice('2590')).toBe('$2,590.00')
  expect(formatPrice(109.6)).toBe('$109.60')
  expect(formatUSD('0.12345')).toBe('$0.12')
})

test('only orders that fill in their own transaction wait for a fill', () => {
  expect(fillsInItsOwnTransaction(buy)).toBe(true)
  expect(
    fillsInItsOwnTransaction(perp({ action: 'close', symbol: 'SOL' })),
  ).toBe(true)
  expect(
    fillsInItsOwnTransaction(
      perp({ action: 'order', orderType: 'limit', limitPrice: '100' }),
    ),
  ).toBe(false)
})

const trigger = (
  triggerPrice: string,
  terms: Partial<PhoenixTrigger> = {},
): PhoenixTrigger => ({
  triggerId: triggerPrice,
  triggerPrice,
  worstPrice: triggerPrice,
  orderKind: 'limit',
  size: null,
  percent: null,
  status: 'active',
  legacy: false,
  ...terms,
})
const position = (terms: Partial<PhoenixPosition>): PhoenixPosition => ({
  symbol: 'SOL',
  subaccount: 0,
  marginMode: 'cross',
  side: 'long',
  size: '2',
  entryPrice: '100',
  markPrice: '105',
  valueUsd: '210',
  unrealizedPnlUsd: '10',
  liquidationPrice: '80',
  fundingUsdc: '0',
  takeProfit: [],
  stopLoss: [],
  ...terms,
})

test('a position without triggers has no summary', () => {
  expect(triggerSummary(position({}))).toBeNull()
})

test('a trigger summary keeps prices short and shows only what exists', () => {
  expect(
    triggerSummary(
      position({
        takeProfit: [trigger('110.50')],
        stopLoss: [trigger('92')],
      }),
    )?.parts,
  ).toEqual(['TP 110.5', 'SL 92'])
  expect(
    triggerSummary(position({ stopLoss: [trigger('2504.25')] }))?.parts,
  ).toEqual(['SL 2,504.25'])
})

test('a partial trigger shows its percent or size; a whole one does not', () => {
  const text = (each: PhoenixTrigger) =>
    triggerSummary(position({ takeProfit: [each] }))?.parts[0]
  expect(text(trigger('110', { percent: 25 }))).toBe('TP 110 (25%)')
  expect(text(trigger('110', { size: '0.5' }))).toBe('TP 110 (0.5 SOL)')
  expect(text(trigger('110', { percent: 100 }))).toBe('TP 110')
  expect(text(trigger('110', { size: '2' }))).toBe('TP 110')
  // A size above the position's still closes the whole of it.
  expect(text(trigger('110', { size: '9' }))).toBe('TP 110')
})

test('several triggers show the nearest and a count, with all in the detail', () => {
  const summary = triggerSummary(
    position({
      takeProfit: [
        trigger('130'),
        trigger('110', { percent: 50, worstPrice: '109.5' }),
        trigger('120'),
      ],
      stopLoss: [trigger('90')],
    }),
  )
  expect(summary?.parts).toEqual(['TP 110 (50%) +2', 'SL 90'])
  expect(summary?.detail.split('\n')).toEqual([
    'TP $110.00 · 50% · worst $109.50 · active',
    'TP $120.00 · worst $120.00 · active',
    'TP $130.00 · worst $130.00 · active',
    'SL $90.00 · worst $90.00 · active',
  ])
})

test('nearest falls back to entry, then to the order Phoenix lists', () => {
  const takeProfit = [trigger('130'), trigger('110')]
  expect(
    triggerSummary(position({ markPrice: null, takeProfit }))?.parts,
  ).toEqual(['TP 110 +1'])
  expect(
    triggerSummary(position({ markPrice: null, entryPrice: null, takeProfit }))
      ?.parts,
  ).toEqual(['TP 130 +1'])
})

test('triggers are not filtered by status, which reads as Phoenix sends it', () => {
  const summary = triggerSummary(
    position({ takeProfit: [trigger('110', { status: 'cancelled' })] }),
  )
  expect(summary?.parts).toEqual(['TP 110'])
  expect(summary?.detail).toBe('TP $110.00 · worst $110.00 · cancelled')
})
