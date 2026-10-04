import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import type { ActivityItem } from '@lanatools/contracts'
import {
  ActivityHeatmap,
  ActivityTotals,
  CallDetail,
  CallRows,
} from './activity'

const now = new Date(2026, 9, 2, 15).getTime()

const paid: ActivityItem = {
  kind: 'payment',
  id: 'call-paid',
  clientId: 'client-1',
  clientName: 'Codex',
  connected: true,
  method: 'GET',
  origin: 'https://weather.example',
  path: '/v1/forecast',
  protocol: 'x402',
  outcome: 'paid',
  network: 'devnet',
  amountMicroUsd: 10_000,
  signature: '5'.repeat(87),
  httpStatus: 200,
  reason: null,
  createdAt: new Date(2026, 9, 2, 14, 31).getTime(),
}
const refused: ActivityItem = {
  ...paid,
  id: 'call-refused',
  protocol: 'mpp',
  outcome: 'refused',
  amountMicroUsd: null,
  signature: null,
  httpStatus: 402,
  reason: 'Payments are turned off for this wallet',
  createdAt: new Date(2026, 9, 2, 9, 5).getTime(),
}
const free: ActivityItem = {
  ...paid,
  id: 'call-free',
  protocol: null,
  outcome: 'free',
  network: null,
  amountMicroUsd: null,
  signature: null,
  createdAt: new Date(2026, 9, 1, 18, 3).getTime(),
}
const failed: ActivityItem = {
  ...free,
  id: 'call-failed',
  outcome: 'failed',
  httpStatus: null,
  reason: 'Could not reach the endpoint',
  createdAt: new Date(2026, 8, 30, 11).getTime(),
}

function rows(items: ActivityItem[], byDay = false) {
  return renderToString(
    <CallRows items={items} onOpen={() => {}} byDay={byDay} now={now} />,
  )
}

function detail(item: ActivityItem) {
  return renderToString(<CallDetail item={item} onClose={() => {}} now={now} />)
}

test('a paid call shows when, who, where, and what it cost', () => {
  const html = rows([paid])
  expect(html).toContain('2:31 PM')
  expect(html).toContain('Codex')
  expect(html).toContain('weather.example')
  expect(html).toContain('/v1/forecast')
  expect(html).toContain('x402')
  expect(html).toContain('$0.01')
})

test('a refused call says why, in the row', () => {
  const html = rows([refused])
  expect(html).toContain('Refused')
  expect(html).toContain('Payments are turned off for this wallet')
  expect(html).not.toContain('$')
})

test('free and failed calls are named, and a failure says why', () => {
  expect(rows([free])).toContain('Free')
  const html = rows([failed])
  expect(html).toContain('Failed')
  expect(html).toContain('Could not reach the endpoint')
})

test('rows carry no icons', () => {
  const html = rows([paid, refused, free, failed])
  expect(html).not.toContain('<svg')
  expect(html).not.toContain('<img')
})

test('the full list is headed by day; the short one is not', () => {
  const html = rows([paid, refused, free, failed], true)
  expect(html.match(/<h3/g)).toHaveLength(3)
  expect(html).toContain('Today')
  expect(html).toContain('Yesterday')
  expect(html).toContain('Sep 30')
  expect(rows([paid, free])).not.toContain('<h3')
})

test('a paid call opens to its transaction and a link to it', () => {
  const html = detail(paid)
  expect(html).toContain('Today at 2:31 PM')
  expect(html).toContain('GET https://weather.example/v1/forecast')
  expect(html).toContain('x402, USDC on devnet')
  expect(html).toContain('HTTP 200')
  expect(html).toContain('5'.repeat(87))
  expect(html).toContain(
    `https://explorer.solana.com/tx/${'5'.repeat(87)}?cluster=devnet`,
  )
})

test('a refused call opens to its reason and no transaction', () => {
  const html = detail(refused)
  expect(html).toContain('Payments are turned off for this wallet')
  expect(html).toContain('$0.00')
  expect(html).not.toContain('Transaction')
})

test('a call from a disconnected or unnamed client still says who made it', () => {
  expect(detail({ ...paid, connected: false })).toContain('Codex, disconnected')
  expect(rows([{ ...paid, clientName: null }])).toContain('Unknown client')
})

test('totals show spend and calls, and a dash until they load', () => {
  const html = renderToString(
    <ActivityTotals
      totals={{ calls: 1234, spentMicroUsd: 460_000, estimatedCredits: 4321 }}
    />,
  )
  expect(html).toContain('$0.46')
  expect(html).toContain('1,234')
  expect(html).toContain('4,321')
  expect(html).toContain('Estimated credits')
  expect(renderToString(<ActivityTotals totals={undefined} />)).toContain('—')
})

test('the chart has a square for each charted day, darkest for the busiest', () => {
  const html = renderToString(
    <ActivityHeatmap
      now={Date.UTC(2026, 9, 2, 12)}
      days={[
        { day: '2026-10-02', calls: 8, spentMicroUsd: 40_000 },
        { day: '2026-10-01', calls: 1, spentMicroUsd: 0 },
        // Outside the window: never drawn.
        { day: '2026-01-01', calls: 99, spentMicroUsd: 0 },
      ]}
    />,
  )
  expect(html.match(/<span title=/g)).toHaveLength(84)
  expect(html).toContain('Oct 2: 8 calls, $0.04 spent')
  expect(html).toContain('Oct 1: 1 call, $0.00 spent')
  expect(html.match(/bg-rule/g)).toHaveLength(82)
})

const tool: ActivityItem = {
  kind: 'tool',
  id: 'tool-ok',
  clientId: 'client-1',
  clientName: 'Codex',
  connected: true,
  tool: 'get_balance',
  provider: 'helius',
  network: 'devnet',
  outcome: 'ok',
  estimatedCredits: 1,
  durationMs: 42,
  reason: null,
  createdAt: paid.createdAt,
}

test('tool rows show name, status and estimated credits beside payments', () => {
  const html = rows([tool, paid])
  expect(html).toContain('get_balance')
  expect(html).toContain('Succeeded')
  expect(html).toContain('Helius')
  expect(html).toContain('1 estimated credit')
  expect(html).toContain('$0.01')
  expect(html).toContain('Helius does not report a per-call cost')
})

test('tool detail labels estimated credits without implying a wallet charge', () => {
  const html = detail(tool)
  expect(html).toContain('get_balance')
  expect(html).toContain('Succeeded')
  expect(html).toContain('Estimated credits')
  expect(html).toContain('Helius does not report a per-call cost')
  expect(html).toContain('devnet')
  expect(html).toContain('42 ms')
  expect(html).not.toContain('$')
  expect(html).not.toContain('Transaction')
  expect(html).not.toContain('Endpoint answered')
})

test('failed tools keep their safe reason and estimate, including zero', () => {
  const failedTool: ActivityItem = {
    ...tool,
    outcome: 'failed',
    reason: 'provider_error',
    estimatedCredits: 0,
    network: null,
  }
  const html = rows([failedTool])
  expect(html).toContain('Failed')
  expect(html).toContain('provider_error')
  expect(html).toContain('0 estimated credits')
  expect(html).not.toContain('$')
  expect(detail(failedTool)).not.toContain('devnet')
})
