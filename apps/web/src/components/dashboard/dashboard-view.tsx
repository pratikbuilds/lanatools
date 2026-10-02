import type { User } from '@privy-io/react-auth'
import { Wordmark } from '#/components/landing/brand'
import { getEmbeddedPayer } from '#/lib/payer'
import type { GetAccessToken } from '#/lib/mcp-clients'
import { AgentPayments } from './agent-payments'
import { ConnectedApps } from './connected-apps'
import { CreateWallet, PaymentWallet } from './wallet-panel'

export function DashboardView({
  user,
  onSignOut,
  signOutFailed,
  getAccessToken,
}: {
  user: Pick<User, 'id' | 'linkedAccounts' | 'google' | 'email'>
  onSignOut: () => void
  signOutFailed: boolean
  getAccessToken: GetAccessToken
}) {
  const payer = getEmbeddedPayer(user)
  const account = user.google?.name || user.google?.email || user.email?.address

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
        {account && (
          <div className="mb-6">
            <p className="text-[12px] text-mute">Signed in as</p>
            <p className="text-[18px] font-bold break-words">{account}</p>
          </div>
        )}
        <p
          role="alert"
          className="mb-4 text-[13px] text-coral-ink empty:hidden"
        >
          {signOutFailed ? 'Sign-out failed. Try again.' : ''}
        </p>
        {payer ? (
          <>
            <PaymentWallet walletAddress={payer.address} />
            <AgentPayments
              userId={user.id}
              walletAddress={payer.address}
              getAccessToken={getAccessToken}
            />
          </>
        ) : (
          <CreateWallet />
        )}
        <ConnectedApps userId={user.id} getAccessToken={getAccessToken} />
      </main>
    </div>
  )
}
