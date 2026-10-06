import { createFileRoute } from '@tanstack/react-router'
import { useConnectWallet } from '@privy-io/react-auth'
import { useSignTransaction, useWallets } from '@privy-io/react-auth/solana'
import { getBase64Encoder } from '@solana/kit'
import { useEffect, useRef, useState } from 'react'
import type { ExternalTransferReview } from '@lanatools/contracts'
import { Frame } from '#/components/dashboard/frame'
import {
  callTransferLink,
  exactSOL,
  signedWireForSubmit,
  tokenFromFragment,
  transferStatus,
} from '#/lib/external-transfer'

export const Route = createFileRoute('/sign')({ component: SignRoute })

function SignRoute() {
  return import.meta.env.VITE_PRIVY_APP_ID ? (
    <ConnectedSigningPage />
  ) : (
    <Frame status={{ start: 'Solana devnet' }}>
      <p role="alert" className="mt-8">
        Wallet connection is not configured for this site.
      </p>
    </Frame>
  )
}

function ConnectedSigningPage() {
  const { wallets, ready } = useWallets()
  const { signTransaction } = useSignTransaction()
  const [connectionError, setConnectionError] = useState('')
  const { connectWallet } = useConnectWallet({
    onError: () =>
      setConnectionError(
        'Wallet connection was cancelled or failed. Try again.',
      ),
  })
  const external = wallets.filter(
    (wallet) => !('privy:' in wallet.standardWallet.features),
  )
  const [selected, setSelected] = useState('')
  const wallet =
    external.find((entry) => entry.address === selected) ?? external[0]
  const currentWallet = useRef(wallet)
  currentWallet.current = wallet
  return (
    <TransferSigningPage
      walletAddress={wallet?.address ?? null}
      walletReady={ready}
      connectionError={connectionError}
      walletChoices={external.map((entry) => entry.address)}
      onSelectWallet={setSelected}
      onConnect={() => {
        setConnectionError('')
        connectWallet({
          walletChainType: 'solana-only',
          description:
            'Connect an external wallet to review and sign this devnet transfer. No LanaTools sign-in is needed.',
        })
      }}
      onSign={async (transaction, expectedAddress) => {
        const signer = currentWallet.current
        if (
          !signer ||
          signer.address !== expectedAddress ||
          !signer.standardWallet.accounts.some(
            (account) => account.address === expectedAddress,
          )
        )
          throw new Error(
            'The connected wallet changed or disconnected. Nothing was submitted.',
          )
        const { signedTransaction } = await signTransaction({
          transaction,
          wallet: signer,
          chain: 'solana:devnet',
        })
        if (
          currentWallet.current?.address !== expectedAddress ||
          !signer.standardWallet.accounts.some(
            (account) => account.address === expectedAddress,
          )
        )
          throw new Error(
            'The wallet changed or disconnected during approval. Nothing was submitted.',
          )
        return signedTransaction
      }}
    />
  )
}

export function TransferSigningPage({
  walletAddress,
  walletReady,
  connectionError,
  walletChoices,
  onSelectWallet,
  onConnect,
  onSign,
}: {
  walletAddress: string | null
  walletReady: boolean
  connectionError: string
  walletChoices: string[]
  onSelectWallet: (address: string) => void
  onConnect: () => void
  onSign: (
    transaction: Uint8Array,
    expectedAddress: string,
  ) => Promise<Uint8Array>
}) {
  const [token] = useState(() =>
    tokenFromFragment(
      typeof window === 'undefined' ? '' : window.location.hash,
    ),
  )
  const [review, setReview] = useState<ExternalTransferReview | null>(null)
  const [phase, setPhase] = useState<
    'idle' | 'loading' | 'preparing' | 'approving' | 'submitting'
  >('idle')
  const [error, setError] = useState('')
  const [mustRefresh, setMustRefresh] = useState(false)
  const actionRunning = useRef(false)
  const walletRef = useRef(walletAddress)
  walletRef.current = walletAddress
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (!token) return
    let active = true
    setPhase('loading')
    void callTransferLink(token, 'review')
      .then((data) => {
        if (active) setReview(data)
      })
      .catch(() => {
        if (active)
          setError(
            'This link could not be loaded. It may be expired or revoked.',
          )
      })
      .finally(() => {
        if (active) setPhase('idle')
      })
    return () => {
      active = false
    }
  }, [token])

  async function refresh() {
    if (!token) return
    setPhase('loading')
    setError('')
    try {
      setReview(await callTransferLink(token, 'review'))
    } catch {
      setError(
        'Could not check status. The outcome remains unknown; do not send again.',
      )
    } finally {
      setPhase('idle')
    }
  }

  async function approve() {
    if (
      !token ||
      !review ||
      !walletAddress ||
      phase !== 'idle' ||
      actionRunning.current
    )
      return
    actionRunning.current = true
    setError('')
    setPhase('preparing')
    try {
      const prepared = await callTransferLink(token, 'prepare', {
        walletAddress,
      })
      setReview(prepared)
      if (prepared.state !== 'issued' || !prepared.transactionBase64) {
        if (['preparing', 'prepared', 'issued'].includes(prepared.state))
          throw new Error(
            'This transfer is not ready to sign. Refresh status before trying again.',
          )
        return
      }
      if (prepared.transactionExpired || prepared.expiresAt <= Date.now())
        throw new Error(
          'This transaction or signing link has expired. Nothing was submitted.',
        )
      if (
        prepared.walletAddress !== walletAddress ||
        walletRef.current !== walletAddress
      )
        throw new Error(
          'Choose the expected source wallet. Nothing was submitted.',
        )
      if (
        prepared.recipient !== review.recipient ||
        prepared.amountLamports !== review.amountLamports
      )
        throw new Error('The transfer changed. Review it again before signing.')
      setPhase('approving')
      let signed: Uint8Array
      try {
        signed = await onSign(
          new Uint8Array(getBase64Encoder().encode(prepared.transactionBase64)),
          walletAddress,
        )
      } catch {
        throw new Error(
          'Wallet approval was rejected or the wallet disconnected. Nothing was submitted. Check your wallet before trying again.',
        )
      }
      if (walletRef.current !== walletAddress)
        throw new Error('The connected wallet changed. Nothing was submitted.')
      const signedBase64 = signedWireForSubmit(
        prepared.transactionBase64,
        signed,
      )
      setMustRefresh(true)
      setPhase('submitting')
      try {
        setReview(await callTransferLink(token, 'submit', { signedBase64 }))
      } catch {
        throw new Error(
          'Submission could not be confirmed. Check status; do not sign or send again.',
        )
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not complete this transfer.',
      )
    } finally {
      actionRunning.current = false
      setPhase('idle')
    }
  }

  const linkExpired = review !== null && review.expiresAt <= now
  const canApprove =
    review !== null &&
    ['requested', 'prepared', 'issued'].includes(review.state) &&
    !review.transactionExpired &&
    !linkExpired &&
    !mustRefresh
  const wrongWallet =
    review?.walletAddress !== null &&
    review?.walletAddress !== undefined &&
    walletAddress !== review.walletAddress
  return (
    <Frame
      status={{ start: 'Solana devnet', end: 'External wallet approval' }}
      mainClassName="py-8"
    >
      <div className="mx-auto max-w-xl">
        <h1 className="text-2xl font-semibold">Review SOL transfer</h1>
        <p className="mt-2 text-sm text-fg-3">
          No LanaTools login is required. Your external wallet approves this one
          transfer.
        </p>
        {!token && (
          <p role="alert" className="mt-5 text-bad">
            This signing link is missing or invalid.
          </p>
        )}
        {review && (
          <div className="d-card mt-6 space-y-4 p-5">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="d-label">Amount</dt>
                <dd className="font-mono text-xl">
                  {exactSOL(review.amountLamports)} SOL
                </dd>
              </div>
              <div>
                <dt className="d-label">Recipient</dt>
                <dd className="break-all font-mono">{review.recipient}</dd>
              </div>
              <div>
                <dt className="d-label">Network</dt>
                <dd>Solana devnet — test funds</dd>
              </div>
              <div>
                <dt className="d-label">Source wallet</dt>
                <dd className="break-all font-mono">
                  {review.walletAddress ??
                    walletAddress ??
                    'Connect an external wallet'}
                </dd>
              </div>
              <div>
                <dt className="d-label">Link expires</dt>
                <dd>{new Date(review.expiresAt).toLocaleString()}</dd>
              </div>
            </dl>
            <p className="text-xs text-fg-3">
              Your source wallet also pays the Solana network fee. Review the
              actual fee in your wallet before approving.
            </p>
            <p role="status">
              {phase === 'approving'
                ? 'Awaiting wallet approval…'
                : phase === 'submitting'
                  ? 'Submitting…'
                  : transferStatus(review)}
            </p>
            {linkExpired && (
              <p className="text-sm text-bad">
                Signing link expired. Further approval and status checks through
                this link are unavailable.
              </p>
            )}
            {review.reason && (
              <p className="text-sm text-bad">{review.reason}</p>
            )}
            {review.signature && (
              <p className="break-all text-xs">
                <a
                  className="underline"
                  href={`https://explorer.solana.com/tx/${encodeURIComponent(review.signature)}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View transaction on devnet explorer
                </a>
              </p>
            )}
          </div>
        )}
        {walletChoices.length > 1 && (
          <label className="mt-5 block text-sm">
            Connected external wallet
            <select
              className="d-input mt-2 w-full"
              value={walletAddress ?? ''}
              disabled={phase !== 'idle'}
              onChange={(event) => onSelectWallet(event.target.value)}
            >
              {walletChoices.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        )}
        {wrongWallet && (
          <p role="alert" className="mt-4 text-bad">
            Connect the source wallet shown above. This transfer cannot use
            another wallet.
          </p>
        )}
        <div className="mt-5 flex flex-wrap gap-3">
          <button
            type="button"
            className="d-btn"
            disabled={!walletReady || phase !== 'idle' || linkExpired || !token}
            onClick={onConnect}
          >
            Connect external wallet
          </button>
          <button
            type="button"
            className="d-btn d-btn-primary"
            disabled={
              !canApprove || !walletAddress || wrongWallet || phase !== 'idle'
            }
            onClick={() => void approve()}
          >
            Sign and submit transfer
          </button>
          <button
            type="button"
            className="d-btn"
            disabled={!token || phase !== 'idle' || linkExpired}
            onClick={() => void refresh()}
          >
            Refresh status
          </button>
        </div>
        {phase === 'loading' && (
          <p role="status" className="mt-4">
            Loading transfer status…
          </p>
        )}
        {phase === 'preparing' && (
          <p role="status" className="mt-4">
            Preparing this exact transfer…
          </p>
        )}
        <p role="alert" className="mt-4 text-sm text-bad empty:hidden">
          {error || connectionError}
        </p>
      </div>
    </Frame>
  )
}
