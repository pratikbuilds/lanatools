import { useSigners } from '@privy-io/react-auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
    mutationFn: ({ enable, address }: { enable: boolean; address: string }) =>
      enable
        ? enablePaymentSigner(getAccessToken, address, addSigners)
        : disablePaymentSigner(getAccessToken, address, removeSigners),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  return { walletAddress, signer, change }
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
  const { walletAddress, signer, change } = usePaymentSigner()
  if (!walletAddress)
    return (
      <p className="px-1 py-5 text-[12px] text-mute">
        Create your payment wallet first. Agent payments turn on with it.
      </p>
    )
  return (
    <AgentPaymentsView
      status={signer.data}
      loadFailed={signer.isError}
      busy={change.isPending}
      error={change.error?.message}
      walletAddress={walletAddress}
      onChange={(enable) => change.mutate({ enable, address: walletAddress })}
    />
  )
}

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
    <div className="grid items-center gap-x-8 gap-y-2 border-b border-rule px-1 py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <b className="block text-[14px]">
          {busy
            ? enabled
              ? 'Turning agent payments off…'
              : 'Turning agent payments on…'
            : enabled
              ? 'Agent payments are on'
              : 'Agent payments are off'}
        </b>
        <p
          className={`mt-1 max-w-[44rem] text-[12px] ${enabled ? 'text-mute' : 'text-coral-ink'}`}
        >
          {enabled
            ? 'LanaTools signs only USDC payments from this wallet, plus network fee instructions, and each client only within its own limit. Turn this off to stop every client at once.'
            : 'No client can pay, and the LanaTools signer is not on your wallet. Turn this on to let your clients pay.'}
        </p>
      </div>
      {status && (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Agent payments"
          disabled={busy}
          onClick={() => onChange(!enabled)}
          className="relative h-[26px] w-11 rounded-full border-[1.5px] border-ink bg-card transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-[17px] after:rounded-full after:bg-ink after:transition-transform disabled:cursor-wait aria-checked:bg-lime aria-checked:after:translate-x-[18px] motion-reduce:transition-none motion-reduce:after:transition-none"
        />
      )}
      <p
        role="alert"
        className="text-[13px] text-coral-ink empty:hidden sm:col-span-2"
      >
        {loadFailed ? 'Could not load payment settings.' : error ? error : ''}
      </p>
    </div>
  )
}
