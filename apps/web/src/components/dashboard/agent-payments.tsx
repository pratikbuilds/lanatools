import { useSigners } from '@privy-io/react-auth'
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import type { PaymentSignerStatus } from '@lanatools/contracts'
import {
  disablePaymentSigner,
  enablePaymentSigner,
  getPaymentSigner,
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

function usePaymentSigner() {
  const { walletAddress, getAccessToken } = useDashboardSession()
  const { addSigners, removeSigners } = useSigners()
  const queryClient = useQueryClient()
  const { queryKey, signer } = useSignerStatus()
  const change = useMutation({
    mutationKey: queryKey,
    mutationFn: ({ enable, address }: { enable: boolean; address: string }) =>
      enable
        ? enablePaymentSigner(getAccessToken, address, addSigners)
        : disablePaymentSigner(getAccessToken, address, removeSigners),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  // The automatic setup and the Settings switch each call this hook. Both
  // read the latest change from either, so the switch waits out a setup that
  // is still running instead of starting a second one.
  const latest = useMutationState({
    filters: { mutationKey: queryKey },
    select: (mutation) => mutation.state,
  }).at(-1)
  return {
    walletAddress,
    signer,
    change,
    busy: latest?.status === 'pending',
    error: latest?.status === 'error' ? latest.error?.message : undefined,
  }
}

/** Whether agents can pay from the wallet shown, as far as is known. */
export function usePaymentsState():
  'on' | 'off' | 'no-wallet' | 'loading' | 'unknown' {
  const { walletAddress } = useDashboardSession()
  const { signer } = useSignerStatus()
  if (!walletAddress) return 'no-wallet'
  if (signer.isError) return 'unknown'
  if (!signer.data) return 'loading'
  return paymentsOn(signer.data, walletAddress) ? 'on' : 'off'
}

/**
 * Turns agent payments on for a wallet that has never had them, so a newly
 * connected client can pay without the user finding a switch first. A wallet
 * the user turned off stays off.
 */
export function useAttachPaymentSigner() {
  const { walletAddress, signer, change } = usePaymentSigner()
  const status = signer.data?.status
  const attempted = useRef(false)

  useEffect(() => {
    // `pending` is an attach that was prepared and never finished: the user
    // has not turned payments off, so it is picked up again.
    if (!walletAddress || (status !== 'none' && status !== 'pending')) return
    // One attempt per visit; a failure is retried from Settings.
    if (attempted.current) return
    attempted.current = true
    change.mutate({ enable: true, address: walletAddress })
  }, [walletAddress, status, change])
}

/**
 * The wallet-wide switch for agent payments. Turning it off stops every
 * connected client at once; each client's own limit is set on the Wallet page.
 */
export function AgentPayments() {
  const { walletAddress, signer, change, busy, error } = usePaymentSigner()
  if (!walletAddress)
    return (
      <p className="d-empty">
        Create your payment wallet first. Agent payments turn on with it.
      </p>
    )
  return (
    <AgentPaymentsView
      status={signer.data}
      loadFailed={signer.isError}
      busy={busy}
      error={error}
      walletAddress={walletAddress}
      onChange={(enable) => change.mutate({ enable, address: walletAddress })}
    />
  )
}

/**
 * Whether agents can pay, as one panel: the state and its switch on the left,
 * what the LanaTools signer is held to on the right.
 */
export function AgentPaymentsView({
  status,
  loadFailed,
  busy,
  error,
  walletAddress,
  onChange,
}: {
  status: PaymentSignerStatus | undefined
  loadFailed: boolean
  busy: boolean
  error: string | undefined
  walletAddress: string
  onChange: (enable: boolean) => void
}) {
  const enabled = paymentsOn(status, walletAddress)

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
                  ) : (
                    'Off'
                  )
                ) : loadFailed ? (
                  '—'
                ) : (
                  <span className="h-[0.95em] w-[1.8em] animate-pulse rounded-[8px] bg-panel-2" />
                )}
              </p>
            </div>
            {status ? (
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                aria-label="Agent payments"
                disabled={busy}
                onClick={() => onChange(!enabled)}
                className="relative h-[26px] w-11 shrink-0 cursor-pointer rounded-full border border-line-2 bg-panel-2 transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-[18px] after:rounded-full after:bg-fg-3 after:transition-transform disabled:cursor-wait aria-checked:border-accent aria-checked:bg-accent aria-checked:after:translate-x-[18px] aria-checked:after:bg-on-accent motion-reduce:transition-none motion-reduce:after:transition-none"
              />
            ) : (
              // Holds the switch's place until the saved state is known.
              !loadFailed && (
                <span
                  aria-hidden="true"
                  className="h-[26px] w-11 shrink-0 animate-pulse rounded-full bg-panel-2"
                />
              )
            )}
          </div>
          <p
            className={`mt-4 max-w-[34rem] empty:hidden ${status && !busy && !enabled ? 'text-bad' : 'text-fg-2'}`}
          >
            {!status
              ? loadFailed
                ? ''
                : 'Checking your wallet…'
              : busy
                ? enabled
                  ? 'Turning agent payments off…'
                  : 'Turning agent payments on…'
                : enabled
                  ? 'Your clients can pay from this wallet. Turn this off to stop every client at once.'
                  : 'No client can pay, and the LanaTools signer is not on your wallet. Turn this on to let your clients pay.'}
          </p>
          <p role="alert" className="mt-2 text-[13px] text-bad empty:hidden">
            {loadFailed
              ? 'Could not load payment settings.'
              : error
                ? error
                : ''}
          </p>
        </>
      }
      right={
        <>
          <h3 className="d-label">Signing rules</h3>
          <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-[13.5px]">
            <dt className="text-fg-3">Token</dt>
            <dd>USDC only</dd>
            <dt className="text-fg-3">Amount</dt>
            <dd>Within each client’s own limit</dd>
            <dt className="text-fg-3">Also signs</dt>
            <dd>Network fee and memo instructions</dd>
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
