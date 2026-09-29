import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import type { McpClient } from '@lanatools/contracts'
import { ConnectedAppList } from './connected-apps'

const now = Date.UTC(2026, 8, 29)

const claude: McpClient = {
  grantId: 'grant-1',
  clientId: 'client-1',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  scopes: ['account:read'],
  connectedAt: now - 3 * 86_400_000,
  lastUsedAt: now - 2 * 3_600_000,
  limitMicroUsd: 0,
  spentMicroUsd: 0,
  reservedMicroUsd: 0,
}

function render(clients: McpClient[]) {
  return renderToString(
    <ConnectedAppList
      clients={clients}
      revokingId={undefined}
      onRevoke={() => {}}
      now={now}
    />,
  )
}

test('each connected app shows who it is, what it can do, and when it was used', () => {
  const html = render([claude])
  expect(html).toContain('Claude')
  expect(html).toContain('claude.ai')
  expect(html).toContain('Can see your LanaTools account ID')
  expect(html).toContain('3 days ago')
  expect(html).toContain('Last used 2 hours ago')
  expect(html).toContain('Disconnect')
})

test('an app without a stored name or use is still identifiable', () => {
  const html = render([
    { ...claude, clientName: null, redirectHost: null, lastUsedAt: null },
  ])
  expect(html).toContain('Unknown app')
  expect(html).toContain('client-1')
  expect(html).toContain('Not used yet')
})

test('with nothing connected, the dashboard says how to connect', () => {
  expect(render([])).toContain('https://mcp.lanatools.sh/mcp')
})

test('an app that can pay shows its limit, spend, reservations, and what is left', () => {
  const html = render([
    {
      ...claude,
      scopes: ['account:read', 'payments:pay'],
      limitMicroUsd: 1_000_000,
      spentMicroUsd: 20_000,
      reservedMicroUsd: 10_000,
    },
  ])
  expect(html).toContain('Can pay from your wallet within its limit')
  expect(html).toContain('$1.00')
  expect(html).toContain('$0.02')
  expect(html).toContain('$0.01')
  expect(html).toContain('$0.97')
  expect(html).toContain('Change limit')
})

test('an app without payments shows no spending controls', () => {
  expect(render([claude])).not.toContain('Change limit')
})
