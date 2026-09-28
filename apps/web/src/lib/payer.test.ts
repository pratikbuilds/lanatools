import { describe, expect, test } from 'bun:test'
import type { User, WalletWithMetadata } from '@privy-io/react-auth'
import { getEmbeddedPayer } from './payer'

type Accounts = User['linkedAccounts']

function wallet(
  address: string,
  walletClientType: string,
  chainType: WalletWithMetadata['chainType'] = 'solana',
): WalletWithMetadata {
  return {
    type: 'wallet',
    address,
    chainType,
    walletClientType,
    connectorType: walletClientType === 'privy' ? 'embedded' : 'injected',
    imported: false,
    delegated: false,
    walletIndex: walletClientType === 'privy' ? 0 : null,
    firstVerifiedAt: null,
    latestVerifiedAt: null,
  }
}

const google: Accounts[number] = {
  type: 'google_oauth',
  subject: 'google-subject',
  email: 'person@example.com',
  name: null,
  firstVerifiedAt: null,
  latestVerifiedAt: null,
}

const phantom = wallet('PhantomAddress1111111111111111111111111111', 'phantom')
const embedded = wallet('EmbeddedAddress111111111111111111111111111', 'privy')

describe('getEmbeddedPayer', () => {
  test('picks the embedded wallet, not the external sign-in wallet', () => {
    const linkedAccounts = [phantom, google, embedded]
    expect(getEmbeddedPayer({ linkedAccounts })?.address).toBe(embedded.address)
  })

  test('never falls back to an external wallet', () => {
    expect(getEmbeddedPayer({ linkedAccounts: [phantom, google] })).toBeNull()
  })

  test('ignores embedded wallets on other chains', () => {
    const linkedAccounts = [wallet('0xEmbedded', 'privy', 'ethereum')]
    expect(getEmbeddedPayer({ linkedAccounts })).toBeNull()
  })
})
