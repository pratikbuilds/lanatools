import { createFileRoute } from '@tanstack/react-router'
import { getAccessToken, usePrivy } from '@privy-io/react-auth'
import { useEffect, useState } from 'react'
import { Wordmark } from '#/components/landing/brand'
import { MCP_URL } from '#/components/landing/copy-url'

export const Route = createFileRoute('/connect')({ component: ConnectRoute })

type Consent = { clientName: string; redirectUri: string }

function ConnectRoute() {
  const { ready, authenticated, user, logout } = usePrivy()
  const [consent, setConsent] = useState<Consent | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const handle = new URLSearchParams(window.location.search).get('handle')
  const mcpOrigin =
    import.meta.env.VITE_MCP_ORIGIN ||
    (import.meta.env.PROD ? new URL(MCP_URL).origin : '')

  useEffect(() => {
    if (!handle || !mcpOrigin) return
    const controller = new AbortController()
    fetch(new URL(`/consent?handle=${encodeURIComponent(handle)}`, mcpOrigin), {
      credentials: 'include',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            'This connection request has expired. Start again from your MCP client.',
          )
        const value: unknown = await response.json()
        if (
          typeof value !== 'object' ||
          value === null ||
          !('clientName' in value) ||
          typeof value.clientName !== 'string' ||
          !('redirectUri' in value) ||
          typeof value.redirectUri !== 'string'
        )
          throw new Error('Invalid connection request')
        setConsent({
          clientName: value.clientName,
          redirectUri: value.redirectUri,
        })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(
            error instanceof Error
              ? error.message
              : 'Could not load connection request',
          )
      })
    return () => controller.abort()
  }, [handle, mcpOrigin])

  async function decide(decision: 'approve' | 'deny') {
    if (!handle || !mcpOrigin) return
    setBusy(true)
    setMessage('')
    try {
      const token = decision === 'approve' ? await getAccessToken() : null
      if (decision === 'approve' && !token) throw new Error('Sign in first')
      const response = await fetch(
        new URL(`/consent?handle=${encodeURIComponent(handle)}`, mcpOrigin),
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ decision }),
        },
      )
      const result: unknown = await response.json()
      if (
        !response.ok ||
        typeof result !== 'object' ||
        result === null ||
        !('redirectTo' in result) ||
        typeof result.redirectTo !== 'string'
      )
        throw new Error('Connection failed. Start again from your MCP client.')
      window.location.assign(result.redirectTo)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Connection failed')
      setBusy(false)
    }
  }

  async function signOut() {
    setBusy(true)
    setMessage('')
    try {
      await logout()
    } catch {
      setMessage('Sign-out failed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const signInReturn = `/connect?handle=${encodeURIComponent(handle || '')}`
  const account =
    user?.google?.email ||
    user?.email?.address ||
    user?.wallet?.address ||
    user?.id

  return (
    <main className="on-paper flex min-h-screen flex-col bg-paper px-5 py-6 text-ink sm:px-8">
      <a href="/" className="font-mono">
        <Wordmark size={27} />
      </a>
      <section className="mx-auto my-auto w-full max-w-[34rem] rounded-[22px] border border-ink/10 bg-card px-6 py-9 shadow-[0_24px_72px_rgb(10_31_110_/_0.08)] sm:px-12 sm:py-12">
        <p className="font-mono text-[11px] font-semibold tracking-[0.15em] text-blue">
          LANATOOLS / CONNECTION
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Connect an MCP client
        </h1>
        {ready && authenticated && (
          <div className="mt-6 rounded-xl border border-ink/10 bg-paper px-4 py-3">
            <p className="text-xs text-mute">Signed in as</p>
            <p className="mt-1 break-all font-mono text-xs text-ink">
              {account}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void signOut()}
              className="mt-2 text-sm font-semibold text-blue underline underline-offset-4 disabled:opacity-50"
            >
              Sign out to use another account
            </button>
          </div>
        )}
        {consent && (
          <>
            <p className="mt-4 text-sm leading-6">
              {consent.clientName} is requesting read-only access to your
              LanaTools account.
            </p>
            <p className="mt-3 break-all text-xs text-mute">
              Callback: {consent.redirectUri}
            </p>
            <p className="mt-3 text-xs text-mute">
              The client name is supplied by the client. This connection cannot
              spend from your wallet.
            </p>
            {ready && !authenticated ? (
              <div className="mt-7 flex items-center gap-5">
                <a
                  className="text-sm font-semibold text-blue underline"
                  href={`/sign-in?next=${encodeURIComponent(signInReturn)}`}
                >
                  Sign in to continue
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide('deny')}
                  className="text-sm text-mute underline disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            ) : (
              <div className="mt-7 flex gap-3">
                <button
                  type="button"
                  disabled={busy || !ready || !authenticated}
                  onClick={() => void decide('approve')}
                  className="rounded-xl bg-blue px-5 py-3 text-sm font-semibold text-white disabled:opacity-50"
                >
                  Connect
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide('deny')}
                  className="rounded-xl border border-ink/20 px-5 py-3 text-sm font-semibold disabled:opacity-50"
                >
                  Deny
                </button>
              </div>
            )}
          </>
        )}
        {!handle && (
          <p className="mt-4 text-sm text-coral-ink">
            Open this page from your MCP client to connect.
          </p>
        )}
        {!mcpOrigin && (
          <p className="mt-4 text-sm text-coral-ink">
            MCP connection is not configured in this environment.
          </p>
        )}
        {message && (
          <p role="alert" className="mt-4 text-sm text-coral-ink">
            {message}
          </p>
        )}
      </section>
    </main>
  )
}
