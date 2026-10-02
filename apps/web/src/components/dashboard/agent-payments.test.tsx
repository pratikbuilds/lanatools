import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { AgentPaymentsView } from './agent-payments'

const wallet = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'

function render(status: Parameters<typeof AgentPaymentsView>[0]['status']) {
  return renderToString(
    <AgentPaymentsView
      status={status}
      loadFailed={false}
      busy={false}
      error={undefined}
      walletAddress={wallet}
      onChange={() => {}}
    />,
  )
}

test('payments that were never set up show as off and can be turned on', () => {
  const html = render({ status: 'none', walletAddress: null })
  expect(html).toContain('Agent payments are off')
  expect(html).toContain('No client can pay')
  expect(html).toContain('aria-checked="false"')
})

test('enabled payments can be stopped for every client', () => {
  const html = render({ status: 'enabled', walletAddress: wallet })
  expect(html).toContain('Agent payments are on')
  expect(html).toContain('stop every client at once')
  expect(html).toContain('aria-checked="true"')
})

test('a signer on a different wallet does not count as on', () => {
  expect(render({ status: 'enabled', walletAddress: 'Other1111' })).toContain(
    'aria-checked="false"',
  )
})

test('the switch waits for the saved state before it can be used', () => {
  expect(render(undefined)).not.toContain('role="switch"')
})
