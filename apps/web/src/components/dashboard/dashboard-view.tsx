import type { User } from '@privy-io/react-auth'
import { Wordmark } from '#/components/landing/brand'
import { getEmbeddedPayer } from '#/lib/payer'
import type { GetAccessToken } from '#/lib/mcp-clients'
import { ConnectedApps } from './connected-apps'
import { CreateWallet, PaymentWallet } from './wallet-panel'

export function DashboardView({
  user,
  onSignOut,
  signOutFailed,
  getAccessToken,
}: {
  user: Pick<User, 'id' | 'linkedAccounts'>
  onSignOut: () => void
  signOutFailed: boolean
  getAccessToken: GetAccessToken
}) {
  const payer = getEmbeddedPayer(user)

  return (
    <div className="on-paper min-h-screen bg-paper text-ink">
      <header className="mx-auto flex w-full max-w-[40rem] items-center justify-between px-5 py-6">
        <a
          href="/"
          aria-label="lanatools home"
          className="[&_.text-paper-2]:text-mute"
        >
          <Wordmark size={26} />
        </a>
        <button type="button" className="btn btn-sm" onClick={onSignOut}>
          Sign out
        </button>
      </header>
      <main className="mx-auto w-full max-w-[40rem] px-5 pt-6 pb-16">
        <p
          role="alert"
          className="mb-4 text-[13px] text-coral-ink empty:hidden"
        >
          {signOutFailed ? 'Sign-out failed. Try again.' : ''}
        </p>
        {payer ? (
          <PaymentWallet walletAddress={payer.address} />
        ) : (
          <CreateWallet />
        )}
        <ConnectedApps userId={user.id} getAccessToken={getAccessToken} />
      </main>
    </div>
  )
}
