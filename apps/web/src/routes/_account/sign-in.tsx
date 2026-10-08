import { Navigate, createFileRoute } from '@tanstack/react-router'
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
import { Frame } from '#/components/dashboard/frame'
import { SolanaMark } from '#/components/dashboard/solana-mark'
import { BrandMark } from '#/components/landing/brand'

export const Route = createFileRoute('/_account/sign-in')({
  component: SignInRoute,
})

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

function Page({
  children,
  card = true,
}: {
  children: ReactNode
  card?: boolean
}) {
  return (
    <Frame
      actions={
        <a href="/" className="d-hdr-pill px-3 focus-visible:outline-lime">
          <span className="hidden sm:inline">Back to home</span>
          <span className="sm:hidden">Home</span>
          <span aria-hidden="true">↗</span>
        </a>
      }
      status={{
        start: (
          <span className="d-status" data-state="live">
            <i aria-hidden="true" />
            Secure access
          </span>
        ),
        end: (
          <span>
            <SolanaMark />
            Built on Solana
          </span>
        ),
      }}
      mainClassName="flex items-center justify-center py-6 sm:py-10"
      // The card is narrow, so the art can come in close around it.
      artColumn={560}
    >
      {card ? (
        <section
          aria-label="Sign in"
          className="d-card w-full max-w-[30rem] px-5 py-6 sm:px-9 sm:py-9"
        >
          {children}
        </section>
      ) : (
        children
      )}
    </Frame>
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
  const { ready, authenticated } = usePrivy()
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
    onError: () => {
      setMessage('Wallet connection failed. Try again.')
      setWalletBusy(false)
    },
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

  // Signed-in users belong on the dashboard, including right after sign-in.
  // This page stays up while the dashboard loads, instead of a blank one.
  if (authenticated)
    return (
      <>
        <Navigate to="/dashboard" replace />
        <Preparing label="Opening your dashboard" />
      </>
    )
  // Until Privy knows whether the visitor is signed in, showing the form
  // would flash it before the dashboard for one who already is.
  if (!ready) return <Preparing label="Preparing sign-in" />

  return (
    <Page>
      <SignInForm
        disabled={googleBusy || walletBusy}
        message={message}
        onGoogle={() => void signInWithGoogle()}
        onWallet={chooseWallet}
      />
    </Page>
  )
}

/** Carries on from the boot screen until Privy is ready. */
function Preparing({ label }: { label: string }) {
  return (
    <Page card={false}>
      <div role="status" className="grid justify-items-center gap-[22px]">
        <span className="animate-pulse motion-reduce:animate-none">
          <BrandMark size={64} />
        </span>
        <p className="d-label">{label}</p>
      </div>
    </Page>
  )
}

function SignInForm({
  disabled,
  message,
  onGoogle,
  onWallet,
}: {
  disabled: boolean
  message: string
  onGoogle?: () => void
  onWallet?: (id?: WalletListEntry) => void
}) {
  return (
    <>
      <p className="d-label">Sign in · Create account</p>
      <h2 className="mt-3 font-mono text-[1.6rem] leading-tight font-semibold tracking-[-0.04em] sm:text-[1.85rem]">
        Sign in to your workspace.
      </h2>
      <p className="mt-2 text-fg-2">
        Sign in or create an account to manage your agents.
      </p>

      <button
        type="button"
        onClick={onGoogle}
        disabled={disabled}
        className="d-btn mt-6 h-12 w-full gap-3 text-[13.5px]"
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="d-label">Or use a Solana wallet</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="overflow-hidden rounded-[10px] border border-line">
        {wallets.map(({ name, id, icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onWallet?.(id)}
            disabled={disabled}
            className="flex h-[54px] w-full cursor-pointer items-center gap-3 border-b border-line bg-panel px-3.5 text-left font-mono text-[13px] font-semibold hover:bg-surface disabled:cursor-not-allowed disabled:opacity-50"
          >
            <img
              src={icon}
              alt=""
              width="30"
              height="30"
              className="size-[30px] rounded-[8px] object-cover"
            />
            <span className="flex-1">{name}</span>
            <span aria-hidden="true" className="text-fg-3">
              →
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => onWallet?.()}
          disabled={disabled}
          className="flex h-[46px] w-full cursor-pointer items-center justify-center gap-2 bg-surface px-3.5 font-mono text-[12.5px] font-medium text-fg-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span>More Solana wallets</span>
        </button>
      </div>

      <p className="mt-5 border-t border-line pt-4 text-[12.5px] text-fg-3">
        A wallet sign-in verifies ownership with a message. No funds move.
      </p>
      <p role="alert" className="mt-3 text-[12.5px] text-bad empty:hidden">
        {message}
      </p>
    </>
  )
}
