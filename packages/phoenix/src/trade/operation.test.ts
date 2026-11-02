import { expect, test } from 'bun:test'
import { phoenixTransactionTools } from '.'

const describe = (name: string, input: unknown) => {
  const tool = phoenixTransactionTools.find((each) => each.name === name)
  if (!tool) throw new Error(`No Phoenix transaction tool ${name}`)
  return tool.transaction.describe(input)
}

test('an isolated order says so before preparation; a cross one stays as it was', () => {
  const isolated = describe('phoenix_market_order', {
    symbol: 'GOLD',
    side: 'buy',
    size: '0.01',
    maxSlippageBps: 50,
    marginMode: 'isolated',
    collateralUsdc: '2',
    collateralSol: '0.05',
  })
  expect(isolated.trade).toMatchObject({
    marginMode: 'isolated',
    collateralUsdc: '2',
    collateralSol: '0.05',
  })
  expect(isolated.description).toContain('isolated Phoenix position')
  expect(isolated.description).toContain(
    "Losses are limited to this position's collateral, and it can be liquidated while your cross account still holds funds.",
  )
  expect(
    describe('phoenix_limit_order', {
      symbol: 'GOLD',
      side: 'buy',
      size: '0.01',
      price: '3000',
      marginMode: 'isolated',
      collateralUsdc: '2',
    }).trade,
  ).toMatchObject({ marginMode: 'isolated', collateralUsdc: '2' })

  const cross = describe('phoenix_market_order', {
    symbol: 'SOL',
    side: 'buy',
    size: '0.1',
    maxSlippageBps: 50,
  })
  expect(cross.trade).not.toHaveProperty('marginMode')
  expect(cross.description).toStartWith(
    'Use your Phoenix cross-margin account.',
  )
})

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
  expect(
    describe('phoenix_close_position', {
      symbol: 'GOLD',
      subaccount: 3,
      limitPrice: '3900',
    }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'close',
    orderType: 'market',
    symbol: 'GOLD',
    marginMode: 'isolated',
    worstPrice: '3900',
    reduceOnly: true,
  })
  expect(
    describe('phoenix_cancel_orders', { symbol: 'GOLD', subaccount: 3 }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'cancel',
    symbol: 'GOLD',
    marginMode: 'isolated',
  })
  expect(
    describe('phoenix_add_isolated_margin', {
      symbol: 'GOLD',
      subaccount: 3,
      amount: '2.5',
    }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'add_margin',
    marginMode: 'isolated',
    symbol: 'GOLD',
    collateralUsdc: '2.5',
  })
  expect(describe('phoenix_deposit', { amount: '25' }).trade).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'deposit',
    amountUsdc: '25',
  })
  expect(
    describe('phoenix_deposit', { amount: '0.5', asset: 'SOL' }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'deposit',
    amountSol: '0.5',
  })
  expect(
    describe('phoenix_withdraw', { amount: '0.5', asset: 'SOL' }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'withdraw',
    amountSol: '0.5',
  })
  expect(describe('phoenix_activate_account', {}).trade).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'activate',
  })
})

test('TP/SL tools carry their terms before preparation', () => {
  const set = describe('phoenix_set_tpsl', {
    symbol: 'SOL',
    subaccount: 3,
    takeProfit: { triggerPrice: '120', worstPrice: '119' },
    stopLoss: { triggerPrice: '110', worstPrice: '105' },
    percent: 50,
  })
  expect(set.trade).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'set_tpsl',
    symbol: 'SOL',
    marginMode: 'isolated',
    takeProfitPrice: '120',
    stopLossPrice: '110',
  })
  expect(set.fields).toContainEqual({
    label: 'takeProfit',
    value: 'triggerPrice 120, worstPrice 119',
  })
  expect(
    describe('phoenix_cancel_tpsl', { symbol: 'SOL', leg: 'both' }).trade,
  ).toEqual({
    kind: 'perp',
    venue: 'phoenix',
    action: 'cancel_tpsl',
    symbol: 'SOL',
  })
})
