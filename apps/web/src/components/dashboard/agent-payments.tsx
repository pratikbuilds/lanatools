import { useSigners } from '@privy-io/react-auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { PaymentSignerStatus } from '@lanatools/contracts'
import type { GetAccessToken } from '#/lib/mcp-clients'
import {
  disablePaymentSigner,
  enablePaymentSigner,
  getPaymentSigner,
} from '#/lib/payment-signer'

/**
 * The wallet-wide switch for agent payments. Turning it off stops every
 * connected app at once; each app's own limit is set in Connected apps.
 */
export function AgentPayments({
  userId,
  walletAddress,
  getAccessToken,
}: {
  userId: string
  walletAddress: string
  getAccessToken: GetAccessToken
}) {
  const { addSigners, removeSigners } = useSigners()
  const queryClient = useQueryClient()
  const queryKey = ['payment-signer', userId]
  const signer = useQuery({
    queryKey,
    queryFn: () => getPaymentSigner(getAccessToken),
  })
  const change = useMutation({
    mutationFn: (enable: boolean) =>
      enable
        ? enablePaymentSigner(getAccessToken, walletAddress, addSigners)
        : disablePaymentSigner(getAccessToken, walletAddress, removeSigners),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  return (
    <AgentPaymentsView
      status={signer.data}
      loadFailed={signer.isError}
      busy={change.isPending}
      error={change.error?.message}
      walletAddress={walletAddress}
      onChange={(enable) => change.mutate(enable)}
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
    <section className="box box-lg mt-8 px-6 py-7 sm:px-8">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">Agent payments</h2>
          <p className="mt-1 text-[13px] text-mute">
            {enabled
              ? 'On. Connected apps can pay from this wallet, each within its own limit.'
              : 'Off. No connected app can pay from this wallet.'}
          </p>
        </div>
        {status && (
          <button
            type="button"
            className={`btn btn-sm shrink-0 disabled:cursor-wait ${enabled ? '' : 'btn-primary'}`}
            disabled={busy}
            onClick={() => onChange(!enabled)}
          >
            {busy
              ? enabled
                ? 'Turning off…'
                : 'Turning on…'
              : enabled
                ? 'Turn off'
                : 'Turn on'}
          </button>
        )}
      </div>
      <p className="mt-3 text-[12.5px] leading-5 text-mute">
        LanaTools signs only USDC payments, plus network fee instructions, and
        each app spends only up to its own limit. Turning this off stops every
        app immediately and removes the LanaTools signer from your wallet.
      </p>
      <p role="alert" className="mt-3 text-[13px] text-coral-ink empty:hidden">
        {loadFailed ? 'Could not load payment settings.' : error ? error : ''}
      </p>
    </section>
  )
}
