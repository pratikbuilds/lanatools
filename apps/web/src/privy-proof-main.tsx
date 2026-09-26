import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { PrivyProvider, usePrivy } from '@privy-io/react-auth'

const appId = import.meta.env.VITE_PRIVY_APP_ID
if (!appId) throw new Error('Set VITE_PRIVY_APP_ID for the local proof page')

function ProofLogin() {
  const { ready, authenticated, error, login, logout, user, getAccessToken } =
    usePrivy()
  const [message, setMessage] = useState('')

  async function copyToken() {
    const token = await getAccessToken()
    if (!token) {
      setMessage('Sign in before copying a token.')
      return
    }
    await navigator.clipboard.writeText(token)
    setMessage('Token copied. Paste it into the ignored root .env file.')
  }

  return (
    <main
      style={{ maxWidth: 560, margin: '4rem auto', fontFamily: 'sans-serif' }}
    >
      <h1>Privy policy proof</h1>
      <p>
        Sign in to the development Privy app, then copy a short-lived token.
      </p>
      {error && <p role="alert">{error.message}</p>}
      {!ready ? (
        <p>Loading Privy…</p>
      ) : authenticated ? (
        <>
          <p>Signed in as {user?.id}</p>
          <button type="button" onClick={() => void copyToken()}>
            Copy test token
          </button>{' '}
          <button type="button" onClick={() => void logout()}>
            Sign out
          </button>
          <p>
            Paste the token into the ignored root <code>.env</code> file as{' '}
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
