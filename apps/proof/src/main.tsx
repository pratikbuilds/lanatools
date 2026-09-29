import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'

const appId = import.meta.env.VITE_PRIVY_APP_ID
if (!appId) throw new Error('Set VITE_PRIVY_APP_ID for the local proof page')

type Mode = 'mpp' | 'x402' | 'denied' | 'policy-denied'
type Proof = {
  mode?: Mode
  passed?: boolean
  error?: string
  checks?: Array<{ name: string; passed: boolean; detail: string }>
  [key: string]: unknown
}

const modes: Array<{ mode: Mode; label: string }> = [
  { mode: 'mpp', label: 'Pay with MPP' },
  { mode: 'x402', label: 'Pay with x402' },
  { mode: 'denied', label: 'Try denied payment' },
  { mode: 'policy-denied', label: 'Try Privy policy denial' },
]

function ProofLogin() {
  const { ready, authenticated, error, login, logout, user, getAccessToken } =
    usePrivy()
  const [message, setMessage] = useState('')
  const [running, setRunning] = useState<Mode>()
  const [proof, setProof] = useState<Proof>()

  async function copyToken() {
    const token = await getAccessToken()
    if (!token) {
      setMessage('Sign in before copying a token.')
      return
    }
    await navigator.clipboard.writeText(token)
    setMessage('Token copied. Paste it into the ignored root .env file.')
  }

  // The access token goes only to the local Pay Kit proof server
  // (`bun run testbed:paykit`) through the proof app's Vite /testbed proxy.
  async function pay(mode: Mode) {
    const token = await getAccessToken()
    if (!token) {
      setMessage('Sign in before paying.')
      return
    }
    setRunning(mode)
    setProof(undefined)
    setMessage('')
    try {
      const response = await fetch('/testbed/pay', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode }),
      })
      setProof(
        (await response.json().catch(() => ({
          error: `Proof server returned HTTP ${response.status}; is bun run testbed:paykit running?`,
        }))) as Proof,
      )
    } catch {
      setProof({ error: 'Could not reach the Pay Kit proof server.' })
    } finally {
      setRunning(undefined)
    }
  }

  return (
    <main
      style={{ maxWidth: 720, margin: '4rem auto', fontFamily: 'sans-serif' }}
    >
      <h1>Privy proofs</h1>
      <p>Sign in to the development Privy app.</p>
      {error && <p role="alert">{error.message}</p>}
      {!ready ? (
        <p>Loading Privy…</p>
      ) : authenticated ? (
        <>
          <p>Signed in as {user?.id}</p>
          <h2>Pay Kit payment (ADI-176)</h2>
          <p>
            Run <code>bun run testbed start</code>, then{' '}
            <code>bun --env-file=.env run testbed:paykit</code> to pay the YAML
            merchant on the hosted Surfpool sandbox. Use{' '}
            <code>testbed:devnet start</code> and{' '}
            <code>testbed:paykit:devnet</code> for devnet.
          </p>
          {modes.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              disabled={!!running}
              onClick={() => void pay(mode)}
              style={{ marginRight: 8 }}
            >
              {running === mode ? 'Running…' : label}
            </button>
          ))}
          {proof && (
            <section aria-label="Proof result">
              <h3>
                {proof.mode ?? 'Proof'}: {proof.passed ? 'passed' : 'failed'}
              </h3>
              {proof.error && <p role="alert">{proof.error}</p>}
              <ul>
                {proof.checks?.map((check) => (
                  <li key={check.name}>
                    {check.passed ? '✅' : '❌'} {check.name} ({check.detail})
                  </li>
                ))}
              </ul>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                {JSON.stringify(proof, null, 2)}
              </pre>
            </section>
          )}
          <h2>Privy policy proof (ADI-175)</h2>
          <button type="button" onClick={() => void copyToken()}>
            Copy test token
          </button>{' '}
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
          <p>
            For <code>testbed:privy</code> only: paste the token into the
            ignored root <code>.env</code> file as{' '}
            <code>PRIVY_USER_ACCESS_TOKEN=…</code>. Do not share it in chat.
          </p>
        </>
      ) : (
        <button type="button" onClick={() => login()}>
          Sign in
        </button>
      )}
      <p role="status">{message}</p>
    </main>
  )
}

const root = document.getElementById('app')
if (!root) throw new Error('Proof page root is missing')

ReactDOM.createRoot(root).render(
  <PrivyProvider appId={appId}>
    <ProofLogin />
  </PrivyProvider>,
)
