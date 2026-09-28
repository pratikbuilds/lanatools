import type { User, WalletWithMetadata } from '@privy-io/react-auth'

type Account = User['linkedAccounts'][number]
type SolanaWallet = WalletWithMetadata & { chainType: 'solana' }

function isSolanaWallet(account: Account): account is SolanaWallet {
  return account.type === 'wallet' && account.chainType === 'solana'
}

function isEmbedded(wallet: SolanaWallet) {
  return (
    wallet.walletClientType === 'privy' ||
    wallet.walletClientType === 'privy-v2'
  )
}

/**
 * The one wallet agent payments come from: the user's Privy embedded Solana
 * wallet. External wallets are sign-in methods and are never returned here,
 * even when they are linked or connected.
 */
export function getEmbeddedPayer(user: Pick<User, 'linkedAccounts'>) {
  return user.linkedAccounts.filter(isSolanaWallet).find(isEmbedded) ?? null
}
