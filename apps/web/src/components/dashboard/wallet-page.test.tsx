import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { DashboardSessionProvider } from './session'
import { AccountMenu } from './shell'
import { WalletPage } from './wallet-page'
import { WalletPanelView } from './wallet-panel'

const embedded = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'

function render(walletAddress: string | null) {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardSessionProvider
        value={{
          userId: 'did:privy:test',
          walletAddress,
          getAccessToken: () => Promise.resolve(null),
        }}
      >
        <WalletPage onViewActivity={() => {}} />
      </DashboardSessionProvider>
    </QueryClientProvider>,
  )
}

test('a user without a payment wallet is asked to create one', () => {
  const html = render(null)
  expect(html).toContain('Create your payment wallet')
  expect(html).not.toContain('Deposit USDC')
})

test('once the payment wallet exists, the page shows it for deposits', () => {
  const html = render(embedded)
  expect(html).not.toContain('Create your payment wallet')
  expect(html).toContain('Available')
  expect(html).toContain('Deposit USDC')
  expect(html).toContain(embedded)
  expect(html).toContain('>F8yp</strong>')
  expect(html).toContain('Hfv7…pChY')
  expect(html).toContain('>jpV3</strong>')
  expect(html).toContain('Withdraw')
})

test('connected clients are on the page with or without a wallet', () => {
  expect(render(null)).toContain('Connected clients')
  expect(render(embedded)).toContain('Connect a client')
})

test('the latest calls follow the clients that made them', () => {
  const html = render(embedded)
  expect(html.indexOf('Latest activity')).toBeGreaterThan(
    html.indexOf('Connected clients'),
  )
})

test('the account control names who is signed in', () => {
  const html = renderToString(
    <AccountMenu
      account={{ label: 'pratik@example.com', detail: 'pratik@example.com' }}
      onSignOut={() => {}}
      signOutFailed={false}
    />,
  )
  expect(html).toContain('pratik@example.com')
  expect(html).toContain('aria-label="Account, pratik@example.com"')
  expect(html).toContain('>P<')
})

test('a wallet sign-in is named by its address', () => {
  const html = renderToString(
    <AccountMenu
      account={{ label: 'Phan…1111', detail: 'PhantomAddress1111' }}
      onSignOut={() => {}}
      signOutFailed={false}
    />,
  )
  expect(html).toContain('Phan…1111')
  expect(html).toContain('aria-label="Account, PhantomAddress1111"')
  expect(html).not.toContain('>?<')
})

test('the SOL that pays withdrawal fees sits beside the balance', () => {
  const view = (sol: bigint) =>
    renderToString(
      <WalletPanelView
        walletAddress={embedded}
        balances={{ usdc: 10_650_000n, sol }}
        pending={false}
        failed={false}
        onDeposit={() => {}}
        onWithdraw={() => {}}
      />,
    )
  expect(view(100_000_000n)).toContain('0.1 SOL')
  expect(view(0n)).toContain('Add SOL to this wallet to withdraw.')
})
