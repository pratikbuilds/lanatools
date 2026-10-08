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

/** The external Solana wallet the user signed in with, if any. */
export function getSignInWallet(user: Pick<User, 'linkedAccounts'>) {
  return (
    user.linkedAccounts
      .filter(isSolanaWallet)
      .find((wallet) => !isEmbedded(wallet)) ?? null
  )
}

/** Who is signed in: a short label, and the full name or address. */
export type AccountName = { label: string; detail: string; wallet: boolean }

/**
 * Names who is signed in: the Google name or email, else the wallet they
 * signed in with, shortened for tight spaces and in full where it is checked.
 */
export function getAccountName(
  user: Pick<User, 'google' | 'email' | 'linkedAccounts'>,
): AccountName | undefined {
  const email = user.google?.email || user.email?.address
  const name = user.google?.name || email
  if (name) return { label: name, detail: email || name, wallet: false }
  const wallet = getSignInWallet(user)
  if (!wallet) return undefined
  const { address } = wallet
  return {
    label: `${address.slice(0, 4)}…${address.slice(-4)}`,
    detail: address,
    wallet: true,
  }
}
