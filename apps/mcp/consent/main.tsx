import { PrivyProvider, usePrivy } from '@privy-io/react-auth'
import { toSolanaWalletConnectors } from '@privy-io/react-auth/solana'
import ReactDOM from 'react-dom/client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { DEFAULT_TOOL_SCOPES } from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'
import { ConsentCard } from './consent-card'
import { SideField } from '../../web/src/components/dashboard/side-field'
import { useTheme } from '../../web/src/components/dashboard/theme'
import './styles.css'

const appId = import.meta.env.VITE_PRIVY_APP_ID
const PendingConsent = z.object({ clientName: z.string().min(1) })

function Connect() {
  const { ready, authenticated, user, login, logout, getAccessToken } =
    usePrivy()
  const [pending, setPending] = useState<z.infer<typeof PendingConsent>>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState<'approve' | 'deny'>()
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

  async function decide(decision: 'approve' | 'deny') {
    if (!handle || !pending) return
    setBusy(decision)
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
      setBusy(undefined)
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
      <ConsentCard
        clientName={pending?.clientName}
        hasHandle={Boolean(handle)}
        ready={ready}
        signedIn={ready && authenticated}
        account={account}
        scopes={scopes}
        limitUsd={limitUsd}
        busy={busy}
        message={message}
        onScopes={setScopes}
        onLimitUsd={setLimitUsd}
        onSignIn={() => login()}
        onSwitchAccount={() => void logout()}
        onDecide={(decision) => void decide(decision)}
      />
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
