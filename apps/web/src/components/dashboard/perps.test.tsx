import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import type { PhoenixPosition, PhoenixTrigger } from '@lanatools/contracts'
import { Positions, chartLevels } from './perps'

const trigger = (triggerPrice: string, status = 'active'): PhoenixTrigger => ({
  triggerId: triggerPrice,
  triggerPrice,
  worstPrice: triggerPrice,
  orderKind: 'limit',
  size: null,
  percent: null,
  status,
  legacy: false,
})
const position: PhoenixPosition = {
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
}
const guarded: PhoenixPosition = {
  ...position,
  symbol: 'BTC',
  takeProfit: [trigger('110.5'), trigger('120')],
  stopLoss: [trigger('92')],
}

const table = (positions: PhoenixPosition[]) =>
  renderToString(
    <Positions positions={positions} focus={undefined} onFocus={() => {}} />,
  ).replaceAll('<!-- -->', '')

test('the positions table has a TP/SL column, with a dash for none', () => {
  const html = table([position])
  expect(html).toContain('>TP/SL</th>')
  expect(html).toContain('>—</td>')
  // No extra line under the market when there is nothing to show.
  expect(html).not.toContain('</small><small')
})

test('a position with triggers shows the nearest and lists all in a title', () => {
  const html = table([guarded])
  // In its column, and under the market where that column is hidden.
  expect(html).toContain(
    '<span class="inline-block whitespace-nowrap">TP 110.5 +1</span> · <span class="inline-block whitespace-nowrap">SL 92</span>',
  )
  expect(html).toMatch(
    /lg:hidden" title="[^"]*">TP 110\.5 \+1 · SL 92<\/small>/,
  )
  expect(html).toContain(
    'title="TP $110.50 · worst $110.50 · active\nTP $120.00 · worst $120.00 · active\nSL $92.00 · worst $92.00 · active"',
  )
})

test('the chart draws every take profit and stop loss with the other levels', () => {
  expect(chartLevels(guarded, [])).toEqual([
    { price: 100, title: 'Entry', tone: 'entry' },
    { price: 80, title: 'Liquidation', tone: 'liquidation' },
    { price: 110.5, title: 'TP', tone: 'takeProfit' },
    { price: 120, title: 'TP', tone: 'takeProfit' },
    { price: 92, title: 'SL', tone: 'stopLoss' },
  ])
})

test('the chart does not filter triggers by status', () => {
  const levels = chartLevels(
    {
      ...position,
      entryPrice: null,
      liquidationPrice: null,
      stopLoss: [trigger('92', 'cancelled')],
    },
    [],
  )
  expect(levels).toEqual([{ price: 92, title: 'SL', tone: 'stopLoss' }])
})
