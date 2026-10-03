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

function usePaymentSigner() {
  const { userId, walletAddress, getAccessToken } = useDashboardSession()
  const { addSigners, removeSigners } = useSigners()
  const queryClient = useQueryClient()
  const queryKey = ['payment-signer', userId]
  const signer = useQuery({
    queryKey,
    queryFn: () => getPaymentSigner(getAccessToken),
  })
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
      <p className="rounded-[10px] border-[1.5px] border-dashed border-mute px-[22px] py-6 text-[13px] leading-5 text-mute">
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
  // Payments are on only for the wallet shown, never a previous one.
  const enabled =
    status?.status === 'enabled' && status.walletAddress === walletAddress

  return (
    <div className="grid overflow-hidden rounded-[10px] border-[1.5px] border-ink bg-card md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="min-w-0 px-6 py-6 sm:px-7">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h3 className="text-[12px] font-normal text-mute">
              Agent payments
            </h3>
            <p className="mt-2.5 flex text-[2.6rem] leading-[0.95] font-bold tracking-[-0.05em]">
              {status ? (
                enabled ? (
                  'On'
                ) : (
                  'Off'
                )
              ) : loadFailed ? (
                '—'
              ) : (
                <span className="h-[0.95em] w-[1.8em] animate-pulse rounded-[8px] bg-paper" />
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
              className="relative h-[26px] w-11 shrink-0 rounded-full border-[1.5px] border-ink bg-card transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-[17px] after:rounded-full after:bg-ink after:transition-transform disabled:cursor-wait aria-checked:bg-lime aria-checked:after:translate-x-[18px] motion-reduce:transition-none motion-reduce:after:transition-none"
            />
          ) : (
            // Holds the switch's place until the saved state is known.
            !loadFailed && (
              <span
                aria-hidden="true"
                className="h-[26px] w-11 shrink-0 animate-pulse rounded-full bg-paper"
              />
            )
          )}
        </div>
        <p
          className={`mt-4 max-w-[34rem] text-[13px] empty:hidden ${status && !busy && !enabled ? 'text-coral-ink' : 'text-mute'}`}
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
        <p
          role="alert"
          className="mt-2 text-[13px] text-coral-ink empty:hidden"
        >
          {loadFailed ? 'Could not load payment settings.' : error ? error : ''}
        </p>
      </div>

      <div className="min-w-0 border-t-[1.5px] border-ink bg-paper px-6 py-6 sm:px-7 md:border-t-0 md:border-l-[1.5px]">
        <h3 className="text-[15px] font-bold">Signing rules</h3>
        <dl className="mt-3.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-[13px]">
          <dt className="text-mute">Token</dt>
          <dd>USDC only</dd>
          <dt className="text-mute">Amount</dt>
          <dd>Within each client’s own limit</dd>
          <dt className="text-mute">Also signs</dt>
          <dd>Network fee and memo instructions</dd>
          <dt className="text-mute">Wallet</dt>
          <dd className="min-w-0">
            <code title={walletAddress} className="block truncate">
              {walletAddress}
            </code>
          </dd>
        </dl>
      </div>
    </div>
  )
}
