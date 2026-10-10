import {
  SOLANA_NETWORKS,
  solanaExplorerTransactionUrl,
} from '@lanatools/contracts/networks'
import { useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import type { PreparedTransaction, TransactionLink } from '@lanatools/contracts'
import {
  getTransactionLink,
  prepareTransactionLink,
  sendTransactionLink,
  signPreparedTransaction,
  TransactionLinkError,
} from '#/lib/transaction-links'
import {
  TransactionWallet,
  TransactionWalletProvider,
} from './transaction-wallet'
import { Frame } from './dashboard/frame'
import { SolanaMark } from './dashboard/solana-mark'
import './transaction-review.css'

const statuses: Record<
  TransactionLink['status'],
  { label: string; detail: string }
> = {
  open: {
    label: 'Awaiting signature',
    detail: 'Connect your wallet, review the details, and sign to send.',
  },
  preparing: {
    label: 'Getting transaction ready',
    detail:
      'Please wait while we load the transaction for the selected wallet.',
  },
  ready: {
    label: 'Ready to sign',
    detail:
      'A transaction has been prepared. No signed transaction has been received.',
  },
  submitting: {
    label: 'Confirming transaction',
    detail: 'Your signature is saved. We are checking confirmation on Solana.',
  },
  confirmed: {
    label: 'Transaction confirmed',
    detail: 'This link is complete. The transaction was confirmed on Solana.',
  },
  failed: {
    label: 'Transaction failed',
    detail: 'This transaction could not be completed.',
  },
  expired: {
    label: 'Link expired',
    detail:
      'This transaction can no longer be sent. Ask the creator for a new link.',
  },
  transaction_expired: {
    label: 'Signing request expired',
    detail:
      'The link is still available. Sign again to use a fresh transaction.',
  },
  unknown: {
    label: 'Confirmation pending',
    detail:
      'Your signature is saved, but confirmation is not available yet. Check its status before starting another transaction.',
  },
  unavailable: {
    label: 'Link unavailable',
    detail: 'The connection that created this link is no longer active.',
  },
}

export function TransactionReview({ linkId }: { linkId: string }) {
  const query = useQuery({
    queryKey: ['transaction-link', linkId],
    queryFn: ({ signal }) => getTransactionLink(linkId, signal),
    retry: false,
    refetchInterval: ({ state }) =>
      state.data &&
      ['preparing', 'submitting', 'unknown'].includes(state.data.status) &&
      state.dataUpdateCount < 20 &&
      state.errorUpdateCount < 3
        ? 3_000
        : false,
  })
  return (
    <TransactionWalletProvider network={query.data?.network}>
      <TransactionPage linkId={linkId} query={query} />
    </TransactionWalletProvider>
  )
}

function TransactionPage({
  linkId,
  query,
}: {
  linkId: string
  query: UseQueryResult<TransactionLink, Error>
}) {
  const client = useQueryClient()
  const { publicKey, connected, signTransaction } = useWallet()
  const account = connected ? publicKey?.toBase58() : undefined
  const [prepared, setPrepared] = useState<PreparedTransaction | null>(null)
  const signedBytes = useRef<string | null>(null)
  const actionLock = useRef(false)
  const [busy, setBusy] = useState<'prepare' | 'sign' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canRetry, setCanRetry] = useState(false)

  const link = query.data
  const canPrepare =
    link &&
    ['open', 'ready', 'transaction_expired'].includes(link.status) &&
    !link.signature
  const walletMismatch = !!(
    link?.account &&
    account &&
    link.account !== account
  )
  const statusRefreshPrimary =
    link &&
    ['preparing', 'submitting', 'unknown'].includes(link.status) &&
    !canRetry

  async function signAndSend() {
    if (
      actionLock.current ||
      (!signedBytes.current &&
        (!account || !signTransaction || !canPrepare || walletMismatch))
    )
      return
    actionLock.current = true
    setError(null)
    setCanRetry(false)
    try {
      if (!signedBytes.current && account && signTransaction) {
        setBusy('prepare')
        const candidate = await prepareTransactionLink(linkId, account)
        if (
          candidate.account !== account ||
          candidate.network !== link?.network
        )
          throw new Error(
            'The transaction does not match this link and wallet.',
          )
        setPrepared(candidate)
        setBusy('sign')
        signedBytes.current = await signPreparedTransaction(
          candidate,
          account,
          signTransaction,
        )
      }
      if (!signedBytes.current) return
      setBusy('send')
      const result = await sendTransactionLink(linkId, signedBytes.current)
      await client.cancelQueries({ queryKey: ['transaction-link', linkId] })
      client.setQueryData<TransactionLink>(
        ['transaction-link', linkId],
        (current) =>
          current && ['confirmed', 'failed'].includes(current.status)
            ? current
            : result,
      )
      setCanRetry(result.status === 'unknown' || result.status === 'submitting')
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The wallet request was cancelled or could not be completed.',
      )
      const rejectedBeforeAcceptance =
        cause instanceof TransactionLinkError &&
        (cause.code === 'transaction_expired' || cause.code === 'invalid_input')
      if (signedBytes.current || rejectedBeforeAcceptance) {
        const refreshed = await query.refetch()
        if (refreshed.data?.status === 'confirmed') setError(null)
        if (
          rejectedBeforeAcceptance &&
          !refreshed.isError &&
          refreshed.data &&
          !refreshed.data.signature
        ) {
          signedBytes.current = null
          setPrepared(null)
          if (cause.code === 'invalid_input')
            setError(
              'The signing request changed before it could be sent. Please sign again.',
            )
        }
      }
      setCanRetry(
        !!signedBytes.current &&
          (rejectedBeforeAcceptance ||
            !(cause instanceof TransactionLinkError) ||
            cause.retryable),
      )
    } finally {
      setBusy(null)
      actionLock.current = false
    }
  }

  return (
    <Frame
      actions={
        <a href="/" className="d-hdr-pill px-3">
          Home
        </a>
      }
      status={{
        start: <span>Public transaction link</span>,
        end: (
          <span>
            <SolanaMark />
            {link ? SOLANA_NETWORKS[link.network].label : 'Solana'}
          </span>
        ),
      }}
      mainClassName="flex items-center justify-center py-6 sm:py-10"
      artColumn={680}
    >
      <section aria-label="Transaction review" className="tx-sheet">
        <div className="tx-details">
          <p className="d-label">Transaction review</p>
          {link ? (
            <Review
              link={prepared ? { ...link, review: prepared.review } : link}
            />
          ) : query.isPending ? (
            <p role="status" className="mt-5 text-fg-2">
              Loading transaction…
            </p>
          ) : (
            <>
              <h1 className="tx-title">Unable to open transaction</h1>
              <p role="alert" className="mt-3 text-fg-2">
                {query.error.message}
              </p>
            </>
          )}
        </div>
        {link && canPrepare && (
          <div className="tx-action-area">
            <div className="tx-next" role="status">
              <h2>
                {signedBytes.current
                  ? busy === 'send'
                    ? 'Confirming transaction'
                    : 'Your wallet has signed'
                  : !account
                    ? 'Connect your wallet'
                    : busy === 'prepare'
                      ? 'Getting your transaction ready'
                      : 'Ready for your signature'}
              </h2>
              <p>
                {signedBytes.current
                  ? 'Submission uses the same transaction. You will not need to sign again.'
                  : !account
                    ? 'Choose the wallet you want to use for this transaction.'
                    : link.status === 'transaction_expired'
                      ? 'Your last signing request timed out. Sign again while this link is still available.'
                      : 'Check the details above, then confirm in your wallet.'}
              </p>
            </div>
            {!signedBytes.current && <TransactionWallet disabled={!!busy} />}
            {account && !signTransaction && (
              <p role="alert" className="tx-error">
                This wallet cannot sign without sending. Choose another wallet.
              </p>
            )}
            {walletMismatch && (
              <p role="alert" className="tx-error">
                This link is reserved for the selected wallet shown above.
                Connect that wallet to continue.
              </p>
            )}
            {account &&
              signTransaction &&
              !walletMismatch &&
              !signedBytes.current && (
                <button
                  type="button"
                  className="tx-primary"
                  disabled={!!busy}
                  onClick={() => void signAndSend()}
                >
                  {busy === 'prepare'
                    ? 'Getting ready…'
                    : busy === 'sign'
                      ? 'Check your wallet…'
                      : busy === 'send'
                        ? 'Sending…'
                        : 'Sign & send'}
                </button>
              )}
            {prepared && (
              <p className="tx-action-note">
                Your wallet signs. LanaTools sends and confirms.
              </p>
            )}
          </div>
        )}
        {link && !canPrepare && (
          <div
            className="tx-result"
            role="status"
            data-confirmed={link.status === 'confirmed' || undefined}
          >
            <p className="d-label">Transaction status</p>
            <h2>{statuses[link.status].label}</h2>
            <p>{statuses[link.status].detail}</p>
            {link.signature &&
              ['submitting', 'unknown'].includes(link.status) &&
              !signedBytes.current && (
                <p>
                  Refreshing checks this transaction. You do not need to connect
                  or sign again.
                </p>
              )}
            {link.signature && (
              <a
                href={solanaExplorerTransactionUrl(
                  link.network,
                  link.signature,
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="tx-explorer"
              >
                <span>View on Solana Explorer</span>
                <span aria-hidden="true">↗</span>
              </a>
            )}
          </div>
        )}
        {canRetry &&
          signedBytes.current &&
          link &&
          ['open', 'ready', 'submitting', 'unknown'].includes(link.status) && (
            <div className="tx-retry">
              <button
                type="button"
                className="tx-primary"
                disabled={!!busy}
                onClick={() => void signAndSend()}
              >
                {busy === 'send' ? 'Sending…' : 'Retry same transaction'}
              </button>
            </div>
          )}
        {busy === 'send' && (
          <p role="status" className="tx-notice">
            LanaTools is sending and checking confirmation.
          </p>
        )}
        {error && link?.status !== 'confirmed' && (
          <p role="alert" className="tx-notice text-bad">
            {error}
          </p>
        )}
        {!query.isPending && link?.status !== 'confirmed' && (
          <div
            className={`tx-utility${statusRefreshPrimary ? ' tx-utility-active' : ''}`}
          >
            {link && !link.signature && (
              <span>
                Link available until{' '}
                <time dateTime={new Date(link.expiresAt).toISOString()}>
                  {new Date(link.expiresAt).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </time>
              </span>
            )}
            <button
              type="button"
              className={
                link && !statusRefreshPrimary ? 'tx-text-button' : 'tx-primary'
              }
              disabled={query.isFetching || !!busy}
              onClick={() => void query.refetch()}
            >
              {query.isFetching
                ? 'Refreshing…'
                : link
                  ? 'Refresh status'
                  : 'Try again'}
            </button>
          </div>
        )}
        {link && query.isError && (
          <p role="alert" className="tx-notice text-bad">
            Could not refresh the status. The last known result is shown.
          </p>
        )}
      </section>
    </Frame>
  )
}

function Review({ link }: { link: TransactionLink }) {
  return (
    <>
      <h1 className="tx-title">{link.review.title}</h1>
      <p className="mt-2 text-fg-2">{link.review.description}</p>
      <dl className="tx-fields">
        {link.review.fields.map((field, index) => (
          <div key={`${field.label}-${index}`}>
            <dt>{field.label}</dt>
            <dd>
              {field.icon && (
                <img
                  src={field.icon}
                  alt=""
                  width="20"
                  height="20"
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="tx-field-icon"
                />
              )}
              <span>{field.value}</span>
            </dd>
          </div>
        ))}
        <div>
          <dt>Network</dt>
          <dd>
            {SOLANA_NETWORKS[link.network].isTestNetwork
              ? `${SOLANA_NETWORKS[link.network].label} · Test funds`
              : SOLANA_NETWORKS[link.network].label}
          </dd>
        </div>
      </dl>
      {link.account && (
        <div className="tx-record">
          <p className="d-label">Selected wallet</p>
          <p>{link.account}</p>
        </div>
      )}
    </>
  )
}
