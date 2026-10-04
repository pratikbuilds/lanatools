import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import ReactDOM from 'react-dom/client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
  MAX_CLIENT_LIMIT_MICRO_USD,
  MCP_SCOPES,
  formatUsd,
  parseClientLimit,
} from '@lanatools/contracts'
import { Permissions } from './permissions'
import { Frame } from '../../web/src/components/dashboard/frame'
import { SolanaMark } from '../../web/src/components/dashboard/solana-mark'
import './styles.css'

const LIMIT_HINT = `Enter an amount up to ${formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}, such as 1.00.`
const appId = import.meta.env.VITE_PRIVY_APP_ID
const PendingConsent = z.object({
  clientName: z.string().min(1),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1),
})

function Connect() {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy()
  const [pending, setPending] = useState<z.infer<typeof PendingConsent>>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [limitUsd, setLimitUsd] = useState('1.00')
  const handle = new URLSearchParams(window.location.search).get('handle')

  useEffect(() => {
    if (!handle) return
    const controller = new AbortController()
    fetch(`/consent?handle=${encodeURIComponent(handle)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('This connection request has expired.')
        setPending(PendingConsent.parse(await response.json()))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(
            error instanceof Error ? error.message : 'Could not load request',
          )
      })
    return () => controller.abort()
  }, [handle])

  const payments = pending?.scopes.includes('payments:pay') ?? false
  const limit = parseClientLimit(limitUsd)

  async function decide(decision: 'approve' | 'deny') {
    if (!handle || !pending) return
    if (decision === 'approve' && payments && limit === null) {
      setMessage(LIMIT_HINT)
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const token = decision === 'approve' ? await getAccessToken() : null
      if (decision === 'approve' && !token) throw new Error('Sign in first.')
      const response = await fetch(
        `/consent?handle=${encodeURIComponent(handle)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(
            decision === 'approve' && payments
              ? { decision, limitUsd }
              : { decision },
          ),
        },
      )
      const body: unknown = await response.json()
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(body)
        throw new Error(
          error.success
            ? error.data.error
            : 'Connection failed. Please try again.',
        )
      }
      const result = z.object({ redirectTo: z.url() }).safeParse(body)
      if (!result.success)
        throw new Error('Connection failed. Start again from your MCP client.')
      window.location.assign(result.data.redirectTo)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connection failed.')
      setBusy(false)
    }
  }

  const account =
    user?.google?.email ||
    user?.email?.address ||
    user?.wallet?.address ||
    user?.id

  return (
    <Frame
      actions={<span className="d-hdr-pill px-3">MCP connection</span>}
      status={{
        start: (
          <span className="d-status" data-state="live">
            <i aria-hidden="true" />
            Secure connection
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
      artColumn={600}
    >
      <section
        aria-labelledby="title"
        className="d-card w-full max-w-[34rem] px-5 py-6 sm:px-9 sm:py-9"
      >
        <p className="d-label">Client access</p>
        <h1
          id="title"
          className="mt-3 font-mono text-[1.6rem] leading-tight font-semibold tracking-[-0.04em] break-words sm:text-[1.85rem]"
        >
          {pending ? `Connect ${pending.clientName}?` : 'Connect a client'}
        </h1>

        {!handle && (
          <p className="mt-2 text-fg-2" role="alert">
            Open this page from your MCP client to connect.
          </p>
        )}

        {pending && (
          <>
            <p className="mt-2 font-mono text-[11.5px] text-fg-3">
              Client name supplied by the app
            </p>

            <Permissions scopes={pending.scopes} />

            {payments && (
              <label className="mt-5 block">
                <span className="d-label">Spending limit for this app</span>
                <span className="mt-2 flex h-11 items-center gap-1 rounded-[9px] border border-line-2 bg-surface px-3 font-mono font-semibold has-aria-invalid:border-bad has-focus-visible:border-accent">
                  <span aria-hidden="true" className="text-fg-3">
                    $
                  </span>
                  <input
                    className="h-full min-w-0 flex-1 bg-transparent font-mono font-semibold outline-none"
                    inputMode="decimal"
                    autoComplete="off"
                    value={limitUsd}
                    disabled={busy}
                    aria-invalid={limit === null}
                    onChange={(event) => setLimitUsd(event.target.value)}
                  />
                  <span className="text-[12px] font-medium text-fg-3">
                    USDC
                  </span>
                </span>
                <span
                  className={`mt-2 block text-[12.5px] ${limit === null ? 'text-bad' : 'text-fg-3'}`}
                >
                  {limit === null
                    ? LIMIT_HINT
                    : `This app can spend ${formatUsd(limit)} in total. You can change or stop this in your dashboard.`}
                </span>
              </label>
            )}

            {ready && authenticated && (
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-line bg-surface px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="d-label block">Signed in as</span>
                  <strong className="mt-0.5 block font-semibold break-all">
                    {account}
                  </strong>
                </span>
                <button
                  type="button"
                  className="d-btn d-btn-sm"
                  disabled={busy}
                  onClick={() => void logout()}
                >
                  Use another account
                </button>
              </div>
            )}

            <p className="mt-5 border-t border-line pt-4 text-[12.5px] text-fg-3">
              Only continue if you started this connection in your app.
            </p>

            <div className="mt-4 flex gap-2.5">
              {ready && !authenticated ? (
                <button
                  type="button"
                  className="d-btn d-btn-primary h-11 flex-1"
                  onClick={() => login()}
                >
                  Sign in
                </button>
              ) : (
                <button
                  type="button"
                  className="d-btn d-btn-primary h-11 flex-1"
                  disabled={!ready || !authenticated || busy}
                  onClick={() => void decide('approve')}
                >
                  Allow access
                </button>
              )}
              <button
                type="button"
                className="d-btn h-11"
                disabled={busy}
                onClick={() => void decide('deny')}
              >
                Deny
              </button>
            </div>
          </>
        )}

        {message && (
          <p role="alert" className="mt-4 text-[13px] text-bad">
            {message}
          </p>
        )}
      </section>
    </Frame>
  )
}

const root = document.getElementById('app')
if (!root) throw new Error('Consent page root is missing')

ReactDOM.createRoot(root).render(
  appId ? (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['google', 'wallet'],
        appearance: {
          walletChainType: 'solana-only',
          walletList: [
            'phantom',
            'solflare',
            'backpack',
            'detected_solana_wallets',
            'wallet_connect',
          ],
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }),
          },
        },
        embeddedWallets: { solana: { createOnLogin: 'off' } },
      }}
    >
      <Connect />
    </PrivyProvider>
  ) : (
    <main className="p-6 text-paper">
      <p role="alert">Privy sign-in is not configured on this server.</p>
    </main>
  ),
)
