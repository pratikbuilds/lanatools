import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { AgentPaymentsView } from './agent-payments'

const wallet = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'

function render(
  status: Parameters<typeof AgentPaymentsView>[0]['status'],
  props: Partial<Parameters<typeof AgentPaymentsView>[0]> = {},
) {
  return renderToString(
    <AgentPaymentsView
      status={status}
      loadFailed={false}
      busy={false}
      error={undefined}
      walletAddress={wallet}
      onChange={() => {}}
      {...props}
    />,
  )
}

test('payments that were never set up show as off and can be turned on', () => {
  const html = render({ status: 'none', walletAddress: null })
  expect(html).toContain('>Off<')
  expect(html).toContain('No client can pay')
  expect(html).toContain('aria-checked="false"')
})

test('enabled payments can be stopped for every client', () => {
  const html = render({ status: 'enabled', walletAddress: wallet })
  expect(html).toContain('>On<')
  expect(html).toContain('stop every client at once')
  expect(html).toContain('aria-checked="true"')
})

test('a signer on a different wallet does not count as on', () => {
  expect(render({ status: 'enabled', walletAddress: 'Other1111' })).toContain(
    'aria-checked="false"',
  )
})

test('the switch waits for the saved state, and nothing is called off before it', () => {
  const html = render(undefined)
  expect(html).not.toContain('role="switch"')
  expect(html).not.toContain('>Off<')
  expect(html).not.toContain('No client can pay')
  expect(html).toContain('Checking your wallet')
})

test('a load failure is reported instead of a state', () => {
  const html = render(undefined, { loadFailed: true })
  expect(html).toContain('Could not load payment settings.')
  expect(html).not.toContain('Checking your wallet')
})

test('the switch cannot start a second change while one is running', () => {
  const html = render(
    { status: 'pending', walletAddress: wallet },
    { busy: true },
  )
  expect(html).toContain('Turning agent payments on…')
  expect(html).toMatch(
    /<button[^>]*disabled=""[^>]*role="switch"|<button[^>]*role="switch"[^>]*disabled=""/,
  )
})

test('the signing rules name the wallet they apply to', () => {
  const html = render({ status: 'enabled', walletAddress: wallet })
  expect(html).toContain('USDC only')
  expect(html).toContain(wallet)
})

test('disabled payments with a removal error offer retry without claiming the signer is gone', () => {
  const html = render(
    { status: 'disabled', walletAddress: wallet },
    { error: 'Removal failed' },
  )
  expect(html).toContain('Remove remaining payment signer')
  expect(html).toContain('cannot cancel already signed transactions')
  expect(html).not.toContain('signer is not on your wallet')
})

test('payment signer removal remains available after reloading a disabled state', () => {
  expect(render({ status: 'disabled', walletAddress: wallet })).toContain(
    'Remove remaining payment signer',
  )
})
