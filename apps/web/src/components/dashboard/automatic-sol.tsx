import { useSigners } from '@privy-io/react-auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TransactionSignerStatus } from '@lanatools/contracts'
import {
  disableTransactionSigner,
  enableTransactionSigner,
  getTransactionSigner,
} from '#/lib/transaction-signer'
import { useDashboardSession } from './session'

export function AutomaticSOL() {
  const { userId, walletAddress, getAccessToken } = useDashboardSession()
  const { addSigners } = useSigners()
  const queryClient = useQueryClient()
  const queryKey = ['transaction-signer', userId]
  const status = useQuery({
    queryKey,
    queryFn: () => getTransactionSigner(getAccessToken),
  })
  const change = useMutation({
    mutationFn: (enable: boolean) => {
      if (!walletAddress) throw new Error('Create your embedded wallet first.')
      return enable
        ? enableTransactionSigner(getAccessToken, walletAddress, addSigners)
        : disableTransactionSigner(getAccessToken, walletAddress)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  return (
    <AutomaticSOLView
      status={status.data}
      walletAddress={walletAddress}
      busy={change.isPending}
      loadFailed={status.isError}
      error={change.error?.message}
      onChange={(enable) => change.mutate(enable)}
      onRefresh={() => void status.refetch()}
    />
  )
}

export function AutomaticSOLView({
  status,
  walletAddress,
  busy,
  loadFailed,
  error,
  onChange,
  onRefresh,
}: {
  status: TransactionSignerStatus | undefined
  walletAddress: string | null
  busy: boolean
  loadFailed: boolean
  error: string | undefined
  onChange: (enable: boolean) => void
  onRefresh: () => void
}) {
  const enabled =
    !!walletAddress &&
    status?.status === 'enabled' &&
    status.walletAddress === walletAddress
  const canEnable = !!walletAddress && status?.setupAvailable === true
  const hasDelegation = status?.status === 'enabled'
  return (
    <div className="d-card mt-5 p-5">
      <h3 className="d-label">Automatic SOL transfers</h3>
      <p className="mt-3 font-mono text-xl">
        {status
          ? enabled
            ? 'On'
            : status.status === 'pending'
              ? 'Setup pending'
              : 'Off'
          : loadFailed
            ? 'Status unknown'
            : 'Checking status…'}
      </p>
      <p className="mt-3 text-[13px] text-fg-2">
        SOL only. After your initial delegation, permitted clients can transfer
        SOL automatically to any recipient, for any amount your wallet can
        cover. No per-transfer approval. Each client also needs its own “Allow
        automatic SOL transfers” permission. Agent payments remain separate.
      </p>
      <p className="mt-2 text-[12px] text-fg-3">
        Turning this off stops new signing authorizations. It cannot cancel
        already signed transactions.
      </p>
      {status && !status.setupAvailable && !enabled && (
        <p className="mt-3 text-[13px] text-fg-3">
          Automatic SOL setup is unavailable in this environment.
        </p>
      )}
      {!walletAddress && (
        <p className="mt-3 text-[13px] text-fg-3">
          Create your embedded wallet first.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="d-btn d-btn-sm"
          disabled={busy || !status || (!hasDelegation && !canEnable)}
          onClick={() => onChange(!hasDelegation)}
        >
          {busy
            ? 'Updating…'
            : hasDelegation
              ? 'Turn off automatic SOL'
              : status?.status === 'pending'
                ? 'Retry SOL delegation'
                : 'Enable automatic SOL'}
        </button>
        {status?.status === 'pending' && (
          <button
            type="button"
            className="d-btn d-btn-sm"
            disabled={busy}
            onClick={() => onChange(false)}
          >
            Cancel SOL delegation
          </button>
        )}
        {status?.status === 'disabled' && (
          <button
            type="button"
            className="d-btn d-btn-sm"
            disabled={busy}
            onClick={() => onChange(false)}
          >
            Remove remaining SOL signer
          </button>
        )}
        <button
          type="button"
          className="d-btn d-btn-sm"
          disabled={busy}
          onClick={onRefresh}
        >
          Refresh SOL status
        </button>
      </div>
      <p role="alert" className="mt-3 text-[13px] text-bad empty:hidden">
        {error ??
          (loadFailed
            ? 'Could not load automatic SOL settings. Refresh status before making a change.'
            : '')}
      </p>
    </div>
  )
}
