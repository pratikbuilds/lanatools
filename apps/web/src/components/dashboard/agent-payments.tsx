import { useSigners } from '@privy-io/react-auth'
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { PaymentSignerStatus } from '@lanatools/contracts'
import {
  attachPaymentSigner,
  getPaymentSigner,
  removePaymentSigner,
} from '#/lib/payment-signer'
import { useDashboardSession } from './session'
import { SplitPanel } from './split-panel'

/** Payments are on only for the wallet shown, never a previous one. */
export function paymentsOn(
  status: PaymentSignerStatus | undefined,
  walletAddress: string,
) {
  return status?.status === 'enabled' && status.walletAddress === walletAddress
}

/** The saved signer state, without the means to change it. */
function useSignerStatus() {
  const { userId, getAccessToken } = useDashboardSession()
  const queryKey = ['payment-signer', userId]
  const signer = useQuery({
    queryKey,
    queryFn: () => getPaymentSigner(getAccessToken),
  })
  return { queryKey, signer }
}

/** A change to LanaTools access: setting it up, or removing it. */
export type AccessChange = 'setup' | 'remove'

function usePaymentSigner() {
  const { userId, walletAddress, getAccessToken } = useDashboardSession()
  const signers = useSigners()
  const queryClient = useQueryClient()
  const { queryKey, signer } = useSignerStatus()
  const onSettled = () => queryClient.invalidateQueries({ queryKey })
  const attach = useMutation({
    mutationKey: [...queryKey, 'setup'],
    mutationFn: ({ address, restore }: { address: string; restore: boolean }) =>
      attachPaymentSigner(getAccessToken, address, restore, signers),
    onSettled,
  })
  const remove = useMutation({
    mutationKey: [...queryKey, 'remove'],
    mutationFn: (address: string) =>
      removePaymentSigner(getAccessToken, address, signers.removeSigners),
    onSettled,
  })
  // The automatic setup and Settings each call this hook. Both read the
  // latest change from either, so Settings waits out a setup that is still
  // running instead of starting a second change.
  const latest = useMutationState({
    filters: { mutationKey: queryKey },
    select: (mutation) => ({
      change: mutation.options.mutationKey?.at(-1),
      state: mutation.state,
    }),
  }).at(-1)
  const change: AccessChange | undefined =
    latest?.change === 'remove' ? 'remove' : latest ? 'setup' : undefined
  return {
    userId,
    walletAddress,
    signer,
    attach,
    remove,
    running: latest?.state.status === 'pending' ? change : undefined,
    failed:
      latest?.state.status === 'error'
        ? { change, message: latest.state.error?.message }
        : undefined,
  }
}

/** Whether agents can pay from the wallet shown, as far as is known. */
export function usePaymentsState():
  'on' | 'off' | 'removed' | 'no-wallet' | 'loading' | 'unknown' {
  const { walletAddress } = useDashboardSession()
  const { signer } = useSignerStatus()
  if (!walletAddress) return 'no-wallet'
  if (signer.isError) return 'unknown'
  if (!signer.data) return 'loading'
  if (signer.data.status === 'disabled') return 'removed'
  return paymentsOn(signer.data, walletAddress) ? 'on' : 'off'
}

/**
 * Sets up agent payments for the wallet shown whenever they are not on, so a
 * connected client can pay without the user doing anything. Access the user
 * removed stays removed until they set it up again in Settings.
 */
export function useAttachPaymentSigner() {
  const { userId, walletAddress, signer, attach, running } = usePaymentSigner()
  const attempted = useRef<string | null>(null)

  useEffect(() => {
    if (!walletAddress || !signer.data || running) return
    if (signer.data.status === 'disabled') return
    if (paymentsOn(signer.data, walletAddress)) return
    // One automatic attempt per account and wallet per visit, so switching
    // accounts sets up the new one. Settings retries a failure.
    const attempt = `${userId}:${walletAddress}`
    if (attempted.current === attempt) return
    attempted.current = attempt
    attach.mutate({ address: walletAddress, restore: false })
  }, [userId, walletAddress, signer.data, running, attach])
}

/**
 * Whether agents can pay from the wallet. Setup runs on its own; here the
 * user retries a failed setup, or removes LanaTools access and sets it up
 * again. Each client's limit is set on the Wallet page.
 */
export function AgentPayments() {
  const { walletAddress, signer, attach, remove, running, failed } =
    usePaymentSigner()
  if (!walletAddress)
    return (
      <p className="d-empty">
        Create your payment wallet first. Agent payments are set up with it.
      </p>
    )
  return (
    <AgentPaymentsView
      status={signer.data}
      loadFailed={signer.isError}
      running={running}
      failed={failed}
      walletAddress={walletAddress}
      onSetUp={() =>
        attach.mutate({
          address: walletAddress,
          restore: signer.data?.status === 'disabled',
        })
      }
      onRemove={() => remove.mutate(walletAddress)}
    />
  )
}

/**
 * Whether agents can pay, as one panel: the state and what can be done about
 * it on the left, what the LanaTools signer is held to on the right.
 */
export function AgentPaymentsView({
  status,
  loadFailed,
  running,
  failed,
  walletAddress,
  onSetUp,
  onRemove,
}: {
  status: PaymentSignerStatus | undefined
  loadFailed: boolean
  running: AccessChange | undefined
  failed:
    | { change: AccessChange | undefined; message: string | undefined }
    | undefined
  walletAddress: string
  onSetUp: () => void
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const enabled = paymentsOn(status, walletAddress)
  const removed = status?.status === 'disabled'
  const idle = status && !running

  return (
    <SplitPanel
      left={
        <>
          <div className="flex items-start justify-between gap-6">
            <div>
              <h3 className="d-label">Agent payments</h3>
              <p className="mt-4 flex font-mono text-[2.6rem] leading-[0.95] font-semibold tracking-[-0.05em]">
                {status ? (
                  enabled ? (
                    'On'
                  ) : removed ? (
                    'Removed'
                  ) : (
                    'Not set up'
                  )
                ) : loadFailed ? (
                  '—'
                ) : (
                  <span className="h-[0.95em] w-[1.8em] animate-pulse rounded-[8px] bg-panel-2" />
                )}
              </p>
            </div>
            {idle && !enabled && (
              <button
                type="button"
                onClick={onSetUp}
                className="d-btn d-btn-sm shrink-0"
              >
                {removed ? 'Set up again' : 'Try again'}
              </button>
            )}
          </div>
          <p className="mt-4 max-w-[34rem] text-fg-2 empty:hidden">
            {!status
              ? loadFailed
                ? ''
                : 'Checking your wallet…'
              : running === 'remove'
                ? 'Removing LanaTools access…'
                : running === 'setup'
                  ? 'Setting up agent payments…'
                  : enabled
                    ? 'Your clients can pay from this wallet within their payment limits. Clients allowed swaps or transfers can send SOL and tokens from it without further approval or an amount limit when transaction signing is set up. Disconnect a client to stop just that one.'
                    : removed
                      ? 'You removed LanaTools access. No client can pay, and LanaTools cannot sign from your wallet.'
                      : 'Your clients cannot pay until the LanaTools signer is on your wallet.'}
          </p>
          <p role="alert" className="mt-2 text-[13px] text-bad empty:hidden">
            {loadFailed
              ? 'Could not load payment settings.'
              : idle && failed?.message
                ? failed.message
                : ''}
          </p>
          {idle &&
            (enabled || (removed && failed?.change === 'remove')) &&
            (confirming && enabled ? (
              <div className="mt-5 rounded-[10px] border border-line bg-surface px-3.5 py-3">
                <p className="text-[13px]">
                  Remove LanaTools access? This stops payments and embedded
                  transactions, and removes the LanaTools signers from your
                  wallet. Transactions already broadcast may still confirm. You
                  can set it up again later.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    className="d-btn d-btn-sm d-btn-danger"
                    onClick={() => {
                      setConfirming(false)
                      onRemove()
                    }}
                  >
                    Remove access
                  </button>
                  <button
                    type="button"
                    className="d-btn d-btn-sm"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="d-btn d-btn-sm d-btn-danger-quiet mt-5"
                onClick={() => (enabled ? setConfirming(true) : onRemove())}
              >
                {enabled ? 'Remove LanaTools access' : 'Try removing again'}
              </button>
            ))}
        </>
      }
      right={
        <>
          <h3 className="d-label">Signing rules</h3>
          <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-[13.5px]">
            <dt className="text-fg-3">API payments</dt>
            <dd>USDC only</dd>
            <dt className="text-fg-3">Payment amount</dt>
            <dd>Within each client’s own limit</dd>
            <dt className="text-fg-3">Transactions</dt>
            <dd>
              When set up, swaps and transfers need no further approval and have
              no amount limit. The client must have the matching permission.
            </dd>
            <dt className="text-fg-3">Wallet</dt>
            <dd className="min-w-0">
              <code
                title={walletAddress}
                className="block truncate font-mono text-[12.5px]"
              >
                {walletAddress}
              </code>
            </dd>
          </dl>
        </>
      }
    />
  )
}
