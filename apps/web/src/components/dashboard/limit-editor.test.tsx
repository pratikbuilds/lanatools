import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import type { McpClient } from '@lanatools/contracts'
import { LimitEditor } from './limit-editor'

const codex: McpClient = {
  grantId: 'grant-1',
  clientId: 'client-1',
  clientName: 'Codex',
  redirectHost: '127.0.0.1:58113',
  scopes: ['account:read', 'payments:pay'],
  connectedAt: 0,
  lastUsedAt: null,
  limitMicroUsd: 1_000_000,
  spentMicroUsd: 340_000,
  reservedMicroUsd: 0,
  estimatedCredits: 0,
}

function render(client: McpClient, balanceMicroUsd: number | undefined) {
  return renderToString(
    <LimitEditor
      client={client}
      balanceMicroUsd={balanceMicroUsd}
      onSave={async () => {}}
    />,
  )
}

test('the ruler ends at what the client has used plus the whole wallet', () => {
  const html = render(codex, 4_520_000)
  expect(html).toContain('$4.86')
  expect(html).toContain('your whole wallet')
  expect(html).toContain('$0.66')
  expect(html).toContain('value="1.00"')
})

test('the ruler never offers more than a client may have', () => {
  const html = render(codex, 5_000_000_000)
  expect(html).toContain('$1,000.00')
  expect(html).toContain('the most a client can have')
})

test('without a known balance there is no ruler, only the amount field', () => {
  const html = render(codex, undefined)
  expect(html).not.toContain('type="range"')
  expect(html).toContain('value="1.00"')
})

test('a limit below what the client has used says it cannot pay', () => {
  const html = render({ ...codex, limitMicroUsd: 200_000 }, 4_520_000)
  expect(html).toContain('Codex has already used $0.34')
})

test('a limit above what the wallet holds says so without blocking it', () => {
  const html = render({ ...codex, limitMicroUsd: 20_000_000 }, 4_520_000)
  expect(html).toContain('Your wallet holds $4.52')
  expect(html).not.toContain('disabled=""')
})

test('a sub-cent limit keeps its digits', () => {
  expect(render({ ...codex, limitMicroUsd: 345_600 }, 4_520_000)).toContain(
    'value="0.3456"',
  )
})

test('the ruler reaches a wallet endpoint that includes fractions of a cent', () => {
  const html = render(
    { ...codex, limitMicroUsd: 103_000, spentMicroUsd: 18_000 },
    85_000,
  )
  expect(html).toMatch(/type="range"[^>]*max="11"[^>]*value="11"/)
  expect(html).toContain('aria-valuetext="$0.103"')
})

test('a wallet smaller than one cent still has a reachable endpoint', () => {
  const html = render(
    { ...codex, limitMicroUsd: 4_000, spentMicroUsd: 0 },
    4_000,
  )
  expect(html).toMatch(/type="range"[^>]*max="1"[^>]*value="1"/)
  expect(html).toContain('aria-valuetext="$0.004"')
})
