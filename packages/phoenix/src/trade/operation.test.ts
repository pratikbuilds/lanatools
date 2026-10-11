import { expect, test } from 'bun:test'
import { phoenixTransactionTools } from '.'

const describe = (name: string, input: unknown) => {
  const tool = phoenixTransactionTools.find((each) => each.name === name)
  if (!tool) throw new Error(`No Phoenix transaction tool ${name}`)
  return tool.transaction.describe(input)
}

test('before preparation the review carries what the agent asked for as trade data', () => {
  expect(
    describe('phoenix_market_order', {
      symbol: 'SOL',
      side: 'sell',
      size: '0.5',
      limitPrice: '110',
      reduceOnly: true,
    }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'order',
    orderType: 'market',
    symbol: 'SOL',
    side: 'sell',
    size: '0.5',
    worstPrice: '110',
    reduceOnly: true,
  })
  expect(
    describe('phoenix_limit_order', {
      symbol: 'ETH',
      side: 'buy',
      size: '1',
      price: '2400',
    }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'order',
    orderType: 'limit',
    symbol: 'ETH',
    side: 'buy',
    size: '1',
    limitPrice: '2400',
    postOnly: false,
    reduceOnly: false,
  })
  expect(
    describe('phoenix_close_position', { symbol: 'SOL', maxSlippageBps: 50 })
      .trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'close',
    orderType: 'market',
    symbol: 'SOL',
    reduceOnly: true,
  })
  expect(
    describe('phoenix_cancel_orders', { symbol: 'SOL', orderIds: ['7', '9'] })
      .trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'cancel',
    symbol: 'SOL',
    cancelled: 2,
  })
  expect(describe('phoenix_deposit', { amount: '25' }).trade).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'deposit',
    amountUsdc: '25',
  })
  expect(describe('phoenix_activate_account', {}).trade).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'activate',
  })
})
