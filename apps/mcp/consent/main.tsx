import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import ReactDOM from 'react-dom/client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import './styles.css'

const appId = import.meta.env.VITE_PRIVY_APP_ID
const PendingConsent = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  redirectUri: z.url(),
  scopes: z.tuple([z.literal('account:read')]),
})

function clientHost(clientId: string) {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' ? url.hostname : null
  } catch {
    return null
  }
}

function Connect() {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy()
  const [pending, setPending] = useState<z.infer<typeof PendingConsent>>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
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

  async function decide(decision: 'approve' | 'deny') {
    if (!handle || !pending) return
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
          body: JSON.stringify({ decision }),
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
  const publishedClient = pending && clientHost(pending.clientId)

  return (
    <main>
      <div className="brand">LANATOOLS / CONNECTION</div>
      <section aria-labelledby="title">
        <h1 id="title">Connect an MCP client</h1>
        {!handle && (
          <p role="alert">Open this page from your MCP client to connect.</p>
        )}
        {pending && (
          <>
            <p>
              <strong>{pending.clientName}</strong> is asking to connect to your
              LanaTools account.
            </p>
            <dl>
              <dt>Access requested</dt>
              <dd>Read the identity of your LanaTools account</dd>
              <dt>Authorization goes to</dt>
              <dd>{redirect?.host}</dd>
              <dt>Client identity</dt>
              <dd>
                {publishedClient
                  ? `Published from ${publishedClient}`
                  : 'Self-registered; the name is not verified'}
              </dd>
            </dl>
            <p className="detail">Callback: {pending.redirectUri}</p>
            {redirect &&
              ['localhost', '127.0.0.1', '[::1]'].includes(
                redirect.hostname,
              ) && (
                <p className="warning">
                  This sends access to an app on your computer. Continue only if
                  you just started this connection.
                </p>
              )}
            <p className="detail">
              This request does not authorize wallet signing or payments. Those
              need a wallet-specific grant and a spending limit.
            </p>
            {ready && authenticated && (
              <div className="account">
                Signed in as <strong>{account}</strong>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => void logout()}
                >
                  Sign out to use another account
                </button>
              </div>
            )}
            <div className="actions">
              {ready && !authenticated ? (
                <button type="button" onClick={() => login()}>
                  Sign in to continue
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!ready || !authenticated || busy}
                  onClick={() => void decide('approve')}
                >
                  Connect
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
          <p role="alert" className="warning">
            {message}
          </p>
        )}
      </section>
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
