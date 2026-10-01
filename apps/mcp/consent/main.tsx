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
import logoUrl from '../../web/public/favicon.svg?url'
import './styles.css'

const LIMIT_HINT = `Enter an amount up to ${formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}, such as 1.00.`
const appId = import.meta.env.VITE_PRIVY_APP_ID
const PendingConsent = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  redirectUri: z.url(),
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
      const result = z
        .object({ redirectTo: z.url() })
        .safeParse(await response.json())
      if (!response.ok || !result.success)
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
  const redirect = pending && new URL(pending.redirectUri)

  return (
    <main className="page">
      <div className="shell">
        <header className="brand">
          <span className="wordmark">
            <img src={logoUrl} alt="" width="30" height="30" />
            <span>
              lanatools<span className="wordmark-suffix">.sh</span>
            </span>
          </span>
          <span className="brand-context">MCP connection</span>
        </header>

        <section className="panel" aria-labelledby="title">
          <p className="eyebrow">Client access</p>
          <h1 id="title">
            {pending ? `Connect ${pending.clientName}?` : 'Connect a client'}
          </h1>

          {!handle && (
            <p className="lede" role="alert">
              Open this page from your MCP client to connect.
            </p>
          )}

          {pending && (
            <>
              <p className="client-note">Client name supplied by the app</p>

              <div className="permission">
                <span className="permission-label">
                  {pending.scopes.length > 1
                    ? 'Permissions requested'
                    : 'Permission requested'}
                </span>
                {pending.scopes.includes('account:read') && (
                  <strong>Read account identity</strong>
                )}
                {payments ? (
                  <>
                    <strong>Pay for requests from your wallet</strong>
                    <span>
                      USDC from your LanaTools payment wallet, only up to the
                      limit you set below.
                    </span>
                  </>
                ) : (
                  <span>No wallet or payment access.</span>
                )}
              </div>

              {payments && (
                <label className="limit">
                  <span className="limit-label">
                    Spending limit for this app
                  </span>
                  <span className="limit-field">
                    <span aria-hidden="true">$</span>
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      value={limitUsd}
                      disabled={busy}
                      aria-invalid={limit === null}
                      onChange={(event) => setLimitUsd(event.target.value)}
                    />
                    <span>USD</span>
                  </span>
                  <span className="limit-help">
                    {limit === null
                      ? LIMIT_HINT
                      : `This app can spend ${formatUsd(limit)} in total. You can change or stop this in your dashboard.`}
                  </span>
                </label>
              )}

              {ready && authenticated && (
                <div className="account">
                  <span className="account-label">Signed in as</span>
                  <strong>{account}</strong>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void logout()}
                  >
                    Sign out to use another account
                  </button>
                </div>
              )}

              <div className="destination">
                <span className="destination-label">Returns to</span>
                <strong>{redirect?.host}</strong>
                {redirect &&
                  ['localhost', '127.0.0.1', '[::1]'].includes(
                    redirect.hostname,
                  ) && (
                    <p>
                      Only continue if you started this in an app on your
                      computer.
                    </p>
                  )}
              </div>

              <details className="details">
                <summary>Connection details</summary>
                <span>Callback URL</span>
                <code>{pending.redirectUri}</code>
                <span>Client ID</span>
                <code>{pending.clientId}</code>
              </details>

              <div className="actions">
                {ready && !authenticated ? (
                  <button type="button" onClick={() => login()}>
                    Sign in
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!ready || !authenticated || busy}
                    onClick={() => void decide('approve')}
                  >
                    Allow access
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void decide('deny')}
                >
                  Deny
                </button>
              </div>
            </>
          )}

          {message && (
            <p role="alert" className="error">
              {message}
            </p>
          )}
        </section>
      </div>
    </main>
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
    <main>
      <p role="alert">Privy sign-in is not configured on this server.</p>
    </main>
  ),
)
