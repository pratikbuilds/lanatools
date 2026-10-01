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

test('payments start off and can be turned on', () => {
  const html = render({ status: 'none', walletAddress: null })
  expect(html).toContain('No connected app can pay')
  expect(html).toContain('Turn on')
})

test('enabled payments can be stopped for every app', () => {
  const html = render({ status: 'enabled', walletAddress: wallet })
  expect(html).toContain('Connected apps can pay from this wallet')
  expect(html).toContain('Turn off')
})

test('a signer on a different wallet does not count as on', () => {
  expect(render({ status: 'enabled', walletAddress: 'Other1111' })).toContain(
    'Turn on',
  )
})
