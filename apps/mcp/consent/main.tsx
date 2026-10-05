import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import ReactDOM from 'react-dom/client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import {
  DEFAULT_TOOL_SCOPES,
  MAX_CLIENT_LIMIT_MICRO_USD,
  formatUsd,
  parseClientLimit,
} from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'
import { ToolAccess } from './permissions'
import { SideField } from '../../web/src/components/dashboard/side-field'
import { useTheme } from '../../web/src/components/dashboard/theme'
import { BrandMark } from '../../web/src/components/landing/brand'
import './styles.css'

const LIMIT_HINT = `Enter an amount up to ${formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}, such as 1.00.`
const appId = import.meta.env.VITE_PRIVY_APP_ID
const PendingConsent = z.object({ clientName: z.string().min(1) })

function Connect() {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy()
  const [pending, setPending] = useState<z.infer<typeof PendingConsent>>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [scopes, setScopes] = useState<ToolScope[]>([...DEFAULT_TOOL_SCOPES])
  const [limitUsd, setLimitUsd] = useState('1.00')
  const handle = new URLSearchParams(window.location.search).get('handle')
  // Follows the system; the page has no header to hold a theme switch.
  const { theme } = useTheme()

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

  const payments = scopes.includes('payments:pay')
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
            decision === 'deny'
              ? { decision }
              : payments
                ? { decision, scopes, limitUsd }
                : { decision, scopes },
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
    <div
      data-theme={theme}
      className="dash flex min-h-screen items-center justify-center px-4 py-8 sm:py-12"
    >
      {/* The card is narrow, so the art can come in close around it. */}
      <SideField column={600} />
      <main
        aria-labelledby="title"
        className="d-card relative z-[1] w-full max-w-[34rem]"
      >
        <header className="d-th flex h-12 items-center justify-between gap-4 border-b border-line px-5 sm:px-7">
          <span className="flex items-center gap-2 font-mono text-[14px] font-bold text-fg">
            <BrandMark size={18} />
            <span>
              lanatools<span className="font-medium text-fg-3">.sh</span>
            </span>
          </span>
          <span className="d-label">MCP connection</span>
        </header>

        <div className="px-5 pt-6 pb-5 sm:px-7">
          <p className="d-label">Client access</p>
          <h1
            id="title"
            className="mt-2.5 font-mono text-[1.6rem] leading-tight font-semibold tracking-[-0.04em] break-words sm:text-[1.85rem]"
          >
            {pending ? `Connect ${pending.clientName}?` : 'Connect a client'}
          </h1>
          {pending ? (
            <p className="mt-1.5 font-mono text-[11.5px] text-fg-3">
              Client name supplied by the app
            </p>
          ) : (
            !handle && (
              <p className="mt-2 text-fg-2" role="alert">
                Open this page from your MCP client to connect.
              </p>
            )
          )}
        </div>

        {pending && (
          <>
            <section
              aria-label="What it can do"
              className="border-t border-line px-5 py-5 sm:px-7"
            >
              <ToolAccess
                selected={scopes}
                onChange={setScopes}
                disabled={busy}
                payLimit={
                  <label className="mt-3 block">
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
                }
              />
              <p className="mt-3 text-[12.5px] text-fg-3">
                To change these later, disconnect the app in your dashboard and
                connect it again.
              </p>
            </section>

            {ready && authenticated && (
              <section
                aria-label="Your account"
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-5 py-4 sm:px-7"
              >
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
              </section>
            )}

            <footer className="border-t border-line bg-surface px-5 py-5 sm:px-7">
              <p className="text-[12.5px] text-fg-3">
                Only continue if you started this connection in your app.
              </p>
              <div className="mt-3 flex gap-2.5">
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
            </footer>
          </>
        )}

        {message && (
          <p
            role="alert"
            className="border-t border-line px-5 py-4 text-[13px] text-bad sm:px-7"
          >
            {message}
          </p>
        )}
      </main>
    </div>
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
