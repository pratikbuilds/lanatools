import { CheckIcon, CopyIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { CopyStatus, copyLabel, useCopy } from '../landing/copy-url'

/** Keep the address intact for selection, with its ends easier to verify. */
export function WalletAddressText({
  walletAddress,
  compact = false,
}: {
  walletAddress: string
  compact?: boolean
}) {
  return (
    <>
      <strong className="font-bold text-fg">{walletAddress.slice(0, 4)}</strong>
      <span className="text-fg-3">
        {compact
          ? `${walletAddress.slice(4, 8)}…${walletAddress.slice(-8, -4)}`
          : walletAddress.slice(4, -4)}
      </span>
      <strong className="font-bold text-fg">{walletAddress.slice(-4)}</strong>
    </>
  )
}

/** One address control, with selectable text and a dedicated copy target. */
export function WalletAddress({
  walletAddress,
  compact = false,
}: {
  walletAddress: string
  compact?: boolean
}) {
  const { state, copy } = useCopy(walletAddress)
  const Icon =
    state === 'copied'
      ? CheckIcon
      : state === 'failed'
        ? WarningCircleIcon
        : CopyIcon

  return (
    <div>
      <div className="flex min-w-0 items-center rounded-[9px] border border-line-2 bg-panel-2/40">
        <code
          title={walletAddress}
          className="min-w-0 flex-1 px-3.5 py-3 font-mono text-[13px] leading-6 break-all select-text"
        >
          <WalletAddressText walletAddress={walletAddress} compact={compact} />
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="d-btn d-btn-sm mr-1.5 h-10 w-10 shrink-0 border-transparent px-0"
          aria-label={copyLabel(state, 'Copy the wallet address')}
          title={copyLabel(state, 'Copy address')}
        >
          <Icon size={19} aria-hidden="true" />
        </button>
      </div>
      <CopyStatus
        state={state}
        subject={compact ? 'full address in Deposit' : 'address'}
      />
      {state === 'failed' && (
        <p className="mt-2 text-[12.5px] text-bad">
          {compact
            ? 'Copy failed. Open Deposit to select the full address.'
            : 'Copy failed. Select the address and copy it manually.'}
        </p>
      )}
    </div>
  )
}
