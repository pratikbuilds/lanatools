import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import type { McpClient } from '@lanatools/contracts'
import { ClientDetail, ClientTable, ClientTotals } from './connected-clients'

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
  estimatedCredits: 0,
}

const paying: McpClient = {
  ...claude,
  scopes: ['account:read', 'payments:pay'],
  limitMicroUsd: 1_000_000,
  spentMicroUsd: 20_000,
  reservedMicroUsd: 10_000,
}

function table(clients: McpClient[]) {
  return renderToString(
    <ClientTable clients={clients} onManage={() => {}} now={now} />,
  )
}

function detail(client: McpClient, revokeFailed = false) {
  return renderToString(
    <ClientDetail
      client={client}
      balanceMicroUsd={4_520_000}
      revoking={false}
      revokeFailed={revokeFailed}
      onSetLimit={async () => {}}
      onRevoke={() => {}}
      onViewActivity={() => {}}
      onClose={() => {}}
      now={now}
    />,
  )
}

test('each connected client shows who it is and when it was used', () => {
  const html = table([claude])
  expect(html).toContain('Claude')
  expect(html).not.toContain('claude.ai')
  expect(html).toContain('2 hours ago')
  expect(html).toContain('Manage')
})

test('a client without a stored name or use is still identifiable', () => {
  const html = table([
    { ...claude, clientName: null, redirectHost: null, lastUsedAt: null },
  ])
  expect(html).toContain('Unknown client')
  expect(html).not.toContain('client-1')
  expect(detail({ ...claude, clientName: null, redirectHost: null })).toContain(
    'client-1',
  )
  expect(html).toContain('Not used yet')
})

test('with nothing connected, the table says what connecting does', () => {
  expect(table([])).toContain('No clients connected yet')
})

test('a client that can pay shows its spend against its limit and what is left', () => {
  const html = table([paying])
  expect(html).toContain('$0.02')
  expect(html).toContain('$1.00')
  // What is left leaves out a payment still being confirmed.
  expect(html).toContain('$0.97')
  expect(html).not.toContain('$0.01')
})

test('a client that cannot pay shows no spending figures', () => {
  const html = table([claude])
  expect(html).toContain('Cannot pay')
  expect(html).not.toContain('$')
})

test('the header totals what every client has spent', () => {
  const html = renderToString(
    <ClientTotals
      clients={[
        paying,
        { ...paying, grantId: 'grant-2', spentMicroUsd: 440_000 },
      ]}
    />,
  )
  expect(html).toContain('2<!-- --> connected')
  expect(html).toContain('$0.46')
})

test('managing a client shows what it can do, its limit, and a way to disconnect', () => {
  const html = detail(paying)
  expect(html).toContain('Pay within its limit, pay.sh catalog')
  expect(html).toContain('3 days ago')
  expect(html).toContain('Spending limit')
  expect(html).toContain('Save limit')
  expect(html).toContain('View its activity')
  expect(html).toContain('Disconnect')
})

test('a failed disconnect is reported in the drawer, where it was asked for', () => {
  expect(detail(paying, true)).toContain('Could not disconnect the client')
  expect(detail(paying)).not.toContain('Could not disconnect the client')
})

test('a client that cannot pay has no limit to change', () => {
  const html = detail(claude)
  expect(html).not.toContain('Spending limit')
  expect(html).not.toContain('Spent')
})

test('the drawer lists the tool families a client may use, and always the catalog', () => {
  const heliusOnly = { ...claude, scopes: ['account:read', 'helius:read'] }
  expect(detail(heliusOnly)).toContain('Helius, pay.sh catalog')
  expect(detail(heliusOnly)).not.toContain('Spending limit')
  expect(table([heliusOnly])).toContain('Cannot pay')
  expect(
    detail({ ...paying, scopes: [...paying.scopes, 'phoenix:read'] }),
  ).toContain('Pay within its limit, Phoenix, pay.sh catalog')
  expect(detail({ ...claude, scopes: ['account:read'] })).toContain(
    'pay.sh catalog',
  )
  expect(detail(claude)).not.toContain('Helius, ')
})

test('credits and host details stay in Manage rather than the client row', () => {
  const html = table([
    { ...claude, estimatedCredits: 1 },
    {
      ...paying,
      grantId: 'grant-2',
      clientId: 'client-2',
      estimatedCredits: 1_234,
    },
  ])
  expect(html).not.toContain('estimated credit')
  expect(html).not.toContain('claude.ai')
  expect(html).toContain('$0.02')
  expect(html).not.toContain('Helius does not report a per-call cost')
  const clientDetail = detail({ ...claude, estimatedCredits: 1_234 })
  expect(clientDetail).toContain('claude.ai')
  expect(clientDetail).toContain('Estimated credits')
  expect(clientDetail).toContain('1,234')
  expect(clientDetail).toContain('Helius does not report a per-call cost')
  expect(clientDetail).not.toContain('$')
})
