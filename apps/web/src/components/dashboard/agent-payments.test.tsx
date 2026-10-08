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
      running={undefined}
      failed={undefined}
      walletAddress={wallet}
      onSetUp={() => {}}
      onRemove={() => {}}
      {...props}
    />,
  )
}

test('payments that are not set up say so and can be retried', () => {
  const html = render({ status: 'none', walletAddress: null })
  expect(html).toContain('>Not set up<')
  expect(html).toContain('Your clients cannot pay')
  expect(html).toContain('Try again')
})

test('payments that are on can have LanaTools access removed, not toggled', () => {
  const html = render({ status: 'enabled', walletAddress: wallet })
  expect(html).toContain('>On<')
  expect(html).toContain('Disconnect a client to stop just that one')
  expect(html).toContain('Remove LanaTools access')
  expect(html).not.toContain('role="switch"')
  expect(html).not.toContain('Try again')
})

test('a signer on a different wallet does not count as on', () => {
  expect(render({ status: 'enabled', walletAddress: 'Other1111' })).toContain(
    '>Not set up<',
  )
})

test('removed access says so and is set up again only by the user', () => {
  const html = render({ status: 'disabled', walletAddress: wallet })
  expect(html).toContain('>Removed<')
  expect(html).toContain('You removed LanaTools access')
  expect(html).toContain('Set up again')
  expect(html).not.toContain('Try removing again')
})

test('a removal that Privy failed can be tried again', () => {
  const html = render(
    { status: 'disabled', walletAddress: wallet },
    { failed: { change: 'remove', message: 'Payments are stopped, but…' } },
  )
  expect(html).toContain('Payments are stopped, but…')
  expect(html).toContain('Try removing again')
})

test('nothing is called not set up before the saved state loads', () => {
  const html = render(undefined)
  expect(html).not.toContain('Not set up')
  expect(html).not.toContain('Try again')
  expect(html).not.toContain('Remove LanaTools access')
  expect(html).toContain('Checking your wallet')
})

test('a load failure is reported instead of a state', () => {
  const html = render(undefined, { loadFailed: true })
  expect(html).toContain('Could not load payment settings.')
  expect(html).not.toContain('Checking your wallet')
})

test('a change in progress cannot be started again', () => {
  const setup = render(
    { status: 'pending', walletAddress: wallet },
    {
      running: 'setup',
      failed: { change: 'setup', message: 'Earlier failure' },
    },
  )
  expect(setup).toContain('Setting up agent payments…')
  expect(setup).not.toContain('Try again')
  expect(setup).not.toContain('Earlier failure')
  const removing = render(
    { status: 'enabled', walletAddress: wallet },
    { running: 'remove' },
  )
  expect(removing).toContain('Removing LanaTools access…')
  expect(removing).not.toContain('Remove LanaTools access')
})

test('a failed setup shows why', () => {
  expect(
    render(
      { status: 'pending', walletAddress: wallet },
      { failed: { change: 'setup', message: 'Nope' } },
    ),
  ).toContain('Nope')
})

test('the signing rules name the wallet they apply to', () => {
  const html = render({ status: 'enabled', walletAddress: wallet })
  expect(html).toContain('USDC only')
  expect(html).toContain(wallet)
})
