import { expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import type { User, WalletWithMetadata } from '@privy-io/react-auth'
import { DashboardView } from './dashboard-view'

function wallet(address: string, walletClientType: string): WalletWithMetadata {
  return {
    type: 'wallet',
    address,
    chainType: 'solana',
    walletClientType,
    connectorType: walletClientType === 'privy' ? 'embedded' : 'injected',
    imported: false,
    delegated: false,
    walletIndex: walletClientType === 'privy' ? 0 : null,
    firstVerifiedAt: null,
    latestVerifiedAt: null,
  }
}

const phantom = wallet(
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  'phantom',
)
const embedded = wallet('F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3', 'privy')

function render(
  linkedAccounts: User['linkedAccounts'],
  profile: Pick<User, 'google' | 'email'> = {},
) {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>
      <DashboardView
        user={{ id: 'did:privy:test', linkedAccounts, ...profile }}
        onSignOut={() => {}}
        signOutFailed={false}
        getAccessToken={() => Promise.resolve(null)}
      />
    </QueryClientProvider>,
  )
}

test('a user signed in with only an external wallet is asked to create one', () => {
  const html = render([phantom])
  expect(html).toContain('Create your payment wallet')
  expect(html).not.toContain(phantom.address)
})

test('once the embedded wallet exists, the dashboard shows it for deposits', () => {
  const html = render([phantom, embedded])
  expect(html).not.toContain('Create your payment wallet')
  expect(html).toContain('Deposit USDC')
  expect(html).toContain(embedded.address)
  expect(html).not.toContain(phantom.address)
})

test('the dashboard shows the Google name, falling back to email', () => {
  const google = {
    subject: 'google-user',
    name: 'Pratik',
    email: 'pratik@example.com',
  }
  expect(render([embedded], { google })).toContain('Pratik')
  expect(render([embedded], { google: { ...google, name: null } })).toContain(
    'pratik@example.com',
  )
  expect(
    render([embedded], { email: { address: 'email@example.com' } }),
  ).toContain('email@example.com')
  expect(render([embedded])).not.toContain('did:privy:test')
})
