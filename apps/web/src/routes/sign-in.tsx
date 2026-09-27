import { createFileRoute } from '@tanstack/react-router'
import {
  useConnectWallet,
  useLoginWithOAuth,
  useLoginWithSiws,
  usePrivy,
} from '@privy-io/react-auth'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  BaseConnectedSolanaWallet,
  WalletListEntry,
} from '@privy-io/react-auth'
import { Wordmark } from '#/components/landing/brand'

export const Route = createFileRoute('/sign-in')({ component: SignInRoute })

const appId = import.meta.env.VITE_PRIVY_APP_ID
const wallets = [
  { name: 'Phantom', id: 'phantom', icon: '/phantom-wallet-logo.png' },
  { name: 'Solflare', id: 'solflare', icon: '/solflare-wallet-logo.png' },
  { name: 'Backpack', id: 'backpack', icon: '/backpack-wallet-logo.png' },
] as const satisfies ReadonlyArray<{
  name: string
  id: WalletListEntry
  icon: string
}>

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="21" height="21" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94a11.05 11.05 0 0 1-4.81 7.26l7.73 6C44.37 38.12 46.98 31.98 46.98 24.55Z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.59.27-3.13.77-4.59l-7.97-6.2A23.86 23.86 0 0 0 0 24c0 3.87.93 7.51 2.56 10.78l7.97-6.19Z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.91-5.72l-7.73-6c-2.14 1.44-4.88 2.3-8.18 2.3-6.26 0-11.57-4.23-13.47-9.99l-7.97 6.19C6.51 42.62 14.62 48 24 48Z"
      />
    </svg>
  )
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="on-paper flex min-h-screen flex-col bg-paper font-[system-ui] text-ink">
      <header className="mx-auto flex w-full max-w-[75rem] items-center justify-between px-5 py-5 sm:px-8 sm:py-7">
        <a
          href="/"
          aria-label="LanaTools home"
          className="font-mono [&_.text-paper-2]:text-mute"
        >
          <Wordmark size={27} />
        </a>
        <a
          href="/"
          className="group flex items-center gap-2 text-xs font-medium text-mute transition-colors hover:text-blue"
        >
          <span className="hidden sm:inline">Back to home</span>
          <span className="sm:hidden">Home</span>
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-full border border-ink/20 text-base leading-none transition-colors group-hover:border-blue"
          >
            ↗
          </span>
        </a>
      </header>

      <main className="mx-auto flex w-full max-w-[75rem] flex-1 items-center justify-center px-5 pb-7 pt-2 sm:px-8 sm:pb-10 lg:py-8">
        <section
          aria-label="Sign in"
          className="w-full max-w-[34rem] rounded-[22px] border border-ink/10 bg-card px-6 py-9 shadow-[0_24px_72px_rgb(10_31_110_/_0.08)] sm:px-12 sm:py-12"
        >
          <div className="mx-auto w-full max-w-[25rem]">{children}</div>
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-[75rem] justify-between gap-4 px-5 pb-6 font-mono text-[10px] tracking-wide text-mute sm:px-8">
        <span>LANATOOLS / SECURE ACCESS</span>
        <span>BUILT ON SOLANA</span>
      </footer>
    </div>
  )
}

function SignInRoute() {
  if (!appId) {
    return (
      <Page>
        <SignInForm
          disabled
          message="Sign-in is unavailable in this environment."
        />
      </Page>
    )
  }

  return <SignIn />
}

function SignIn() {
  const { ready, authenticated, user, logout } = usePrivy()
  const [message, setMessage] = useState('')
  const [walletBusy, setWalletBusy] = useState(false)
  const { initOAuth, loading: googleBusy } = useLoginWithOAuth({
    onError: () => setMessage('Google sign-in failed. Try again.'),
  })
  const { generateSiwsMessage, loginWithSiws } = useLoginWithSiws()

  async function signInWithWallet(wallet: BaseConnectedSolanaWallet) {
    try {
      const signInMessage = await generateSiwsMessage({
        address: wallet.address,
      })
      const { signature } = await wallet.provider.signMessage({
        message: new TextEncoder().encode(signInMessage),
      })
      await loginWithSiws({
        message: signInMessage,
        signature: btoa(String.fromCharCode(...signature)),
        walletClientType: wallet.walletClientType,
        connectorType: wallet.connectorType,
      })
    } catch {
      setMessage('Wallet sign-in failed. Check your wallet and try again.')
    } finally {
      setWalletBusy(false)
    }
  }

  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      if (wallet.type === 'solana') void signInWithWallet(wallet)
      else {
        setMessage('Choose a Solana wallet to sign in.')
        setWalletBusy(false)
      }
    },
    onError: () => setWalletBusy(false),
  })

  function chooseWallet(id?: WalletListEntry) {
    setMessage('')
    setWalletBusy(true)
    connectWallet({
      ...(id ? { walletList: [id] } : {}),
      walletChainType: 'solana-only',
      description: 'Connect your wallet to sign in to LanaTools.',
    })
  }

  async function signInWithGoogle() {
    setMessage('')
    try {
      await initOAuth({ provider: 'google' })
    } catch {
      setMessage('Google sign-in failed. Try again.')
    }
  }

  async function signOut() {
    setMessage('')
    try {
      await logout()
    } catch {
      setMessage('Sign-out failed. Try again.')
    }
  }

  if (authenticated) {
    return (
      <Page>
        <div className="mb-5 flex size-10 items-center justify-center rounded-full bg-lime text-xl text-ink">
          ✓
        </div>
        <h2 className="text-2xl font-semibold tracking-tight">
          You’re signed in.
        </h2>
        <p className="mt-3 text-sm leading-6 text-mute">
          You can return to the home page or sign out.
        </p>
        <p className="mt-6 break-all rounded-lg bg-paper px-4 py-3 font-mono text-xs text-mute">
          Account ID: {user?.id}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-6 text-sm font-semibold text-blue underline underline-offset-4 hover:text-blue-deep"
        >
          Sign out
        </button>
        <p role="alert" className="mt-4 text-xs text-coral-ink empty:hidden">
          {message}
        </p>
      </Page>
    )
  }

  const disabled = !ready || googleBusy || walletBusy

  return (
    <Page>
      <SignInForm
        disabled={disabled}
        loading={!ready}
        message={message}
        onGoogle={() => void signInWithGoogle()}
        onWallet={chooseWallet}
      />
    </Page>
  )
}

function SignInForm({
  disabled,
  loading = false,
  message,
  onGoogle,
  onWallet,
}: {
  disabled: boolean
  loading?: boolean
  message: string
  onGoogle?: () => void
  onWallet?: (id?: WalletListEntry) => void
}) {
  return (
    <>
      <p className="font-mono text-[11px] font-semibold tracking-[0.15em] text-blue">
        LANATOOLS / ACCOUNT
      </p>
      <h2 className="mt-4 text-[2.1rem] leading-tight font-semibold tracking-[-0.05em] sm:text-[2.5rem]">
        Sign in to your workspace.
      </h2>
      <p className="mt-3 text-sm leading-6 text-mute">
        Sign in or create an account to manage your agents.
      </p>

      <button
        type="button"
        onClick={onGoogle}
        disabled={disabled}
        className="mt-8 flex h-[54px] w-full items-center justify-center gap-3 rounded-xl border border-ink/20 bg-card text-sm font-semibold text-ink transition-all hover:-translate-y-0.5 hover:border-blue hover:shadow-[0_6px_18px_rgb(10_31_110_/_0.08)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div className="my-6 flex items-center gap-4">
        <span className="h-px flex-1 bg-rule" />
        <span className="font-mono text-[10px] font-medium tracking-wide text-mute">
          OR CONTINUE WITH A WALLET
        </span>
        <span className="h-px flex-1 bg-rule" />
      </div>

      <div className="space-y-2">
        {wallets.map(({ name, id, icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onWallet?.(id)}
            disabled={disabled}
            className="flex h-14 w-full items-center justify-center gap-3 rounded-xl border border-ink/10 bg-paper/55 px-3 text-sm font-semibold text-ink transition-all hover:-translate-y-0.5 hover:border-blue/55 hover:bg-card hover:shadow-[0_6px_18px_rgb(10_31_110_/_0.08)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
          >
            <img
              src={icon}
              alt=""
              width="34"
              height="34"
              className="size-[34px] rounded-[9px] object-cover"
            />
            <span>{name}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={() => onWallet?.()}
        disabled={disabled}
        className="mt-2 flex h-14 w-full items-center justify-center gap-3 rounded-xl border border-dashed border-ink/20 px-3 text-sm font-semibold text-blue transition-colors hover:border-blue hover:bg-paper/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className="grid size-[34px] grid-cols-2 gap-[3px] rounded-[9px] bg-blue/8 p-[9px]"
        >
          <span className="rounded-[2px] bg-blue" />
          <span className="rounded-[2px] bg-blue/50" />
          <span className="rounded-[2px] bg-blue/50" />
          <span className="rounded-[2px] bg-blue" />
        </span>
        <span>More Solana wallets</span>
      </button>

      <p className="mt-6 border-t border-rule pt-5 text-xs leading-5 text-mute">
        A wallet sign-in verifies ownership with a message. No funds move.
      </p>
      <p
        role="alert"
        className="mt-4 text-xs leading-5 text-coral-ink empty:hidden"
      >
        {message}
      </p>
      {loading && (
        <p role="status" className="mt-4 text-xs text-mute">
          Preparing sign-in…
        </p>
      )}
    </>
  )
}
