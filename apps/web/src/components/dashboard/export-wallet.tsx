import { useExportWallet } from '@privy-io/react-auth/solana'
import { useMutation } from '@tanstack/react-query'
import { useDashboardSession } from './session'

/**
 * Lets the user take the payment wallet's private key to another wallet app.
 * Privy shows the key in its own window on its own domain, so LanaTools never
 * sees it.
 */
export function ExportWallet() {
  const { walletAddress } = useDashboardSession()
  const { exportWallet } = useExportWallet()
  const exporting = useMutation({
    mutationFn: (address: string) => exportWallet({ address }),
  })
  if (!walletAddress)
    return (
      <p className="d-empty">
        Create your payment wallet first. Its private key can be exported then.
      </p>
    )
  return (
    <ExportWalletView
      exporting={exporting.isPending}
      failed={exporting.isError}
      onExport={() => exporting.mutate(walletAddress)}
    />
  )
}

export function ExportWalletView({
  exporting,
  failed,
  onExport,
}: {
  exporting: boolean
  failed: boolean
  onExport: () => void
}) {
  return (
    <div className="d-frame">
      <div className="d-inset d-pane">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div>
            <h3 className="d-label">Private key</h3>
            <p className="mt-3 max-w-[34rem] text-fg-2">
              Use your payment wallet in another wallet app. Anyone with this
              key controls your funds, and spending limits do not apply to it.
            </p>
          </div>
          <button
            type="button"
            className="d-btn d-btn-sm shrink-0 disabled:cursor-wait"
            disabled={exporting}
            onClick={onExport}
          >
            Export private key
          </button>
        </div>
        <p role="alert" className="mt-3 text-[13px] text-bad empty:hidden">
          {failed ? 'Could not open the private key export. Try again.' : ''}
        </p>
      </div>
    </div>
  )
}
