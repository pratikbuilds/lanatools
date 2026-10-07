import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { AutomaticSOLView } from './automatic-sol'

const wallet = '11111111111111111111111111111111'
function render(
  status: Parameters<typeof AutomaticSOLView>[0]['status'],
  props: Partial<Parameters<typeof AutomaticSOLView>[0]> = {},
) {
  return renderToString(
    <AutomaticSOLView
      status={status}
      walletAddress={wallet}
      busy={false}
      loadFailed={false}
      error={undefined}
      onChange={() => {}}
      onRefresh={() => {}}
      {...props}
    />,
  )
}

test('setup unavailable is off and requires an explicit owner action', () => {
  const html = render({
    status: 'none',
    walletAddress: null,
    setupAvailable: false,
  })
  expect(html).toContain('>Off<')
  expect(html).toContain(
    'Automatic SOL setup is unavailable in this environment',
  )
  expect(html).toMatch(/disabled=""[^>]*>Enable automatic SOL/)
  expect(html).toContain('any recipient')
  expect(html).toContain('SOL only')
  expect(html).toContain('any amount')
  expect(html).toContain('No per-transfer approval')
  expect(html).toContain('Each client also needs')
})

test('enabled delegation is wallet-specific and can be disabled even while setup is unavailable', () => {
  const status = {
    status: 'enabled',
    walletAddress: wallet,
    setupAvailable: false,
  } as const
  expect(render(status)).toContain('>On<')
  expect(render(status)).toContain('Turn off automatic SOL')
  expect(render(status, { walletAddress: 'other' })).toContain('>Off<')
})

test('pending and removal failures show accurate retry controls', () => {
  expect(
    render({ status: 'pending', walletAddress: wallet, setupAvailable: true }),
  ).toContain('Retry SOL delegation')
  expect(
    render({ status: 'pending', walletAddress: wallet, setupAvailable: false }),
  ).toContain('Cancel SOL delegation')
  const failed = render(
    { status: 'disabled', walletAddress: wallet, setupAvailable: false },
    { error: 'Removal failed' },
  )
  expect(failed).toContain('Remove remaining SOL signer')
  expect(failed).toContain('cannot cancel already signed transactions')
  expect(failed).not.toContain('signer is not on')
})

test('unknown status and pending changes never claim success', () => {
  expect(render(undefined, { loadFailed: true })).toContain('Status unknown')
  expect(render(undefined, { loadFailed: true })).toContain(
    'Refresh status before',
  )
  const pending = render(
    { status: 'none', walletAddress: null, setupAvailable: true },
    { busy: true },
  )
  expect(pending).toContain('Updating…')
  expect(pending).toMatch(/disabled=""[^>]*>Updating/)
})

test('SOL signer removal remains available after reloading a disabled state', () => {
  expect(
    render({
      status: 'disabled',
      walletAddress: wallet,
      setupAvailable: false,
    }),
  ).toContain('Remove remaining SOL signer')
})
