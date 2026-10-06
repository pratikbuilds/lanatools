import { CopyIcon } from '@phosphor-icons/react'
import { QRCodeSVG } from 'qrcode.react'
import { CopyStatus, copyLabel, useCopy } from '#/components/landing/copy-url'
import { NETWORK } from '#/lib/solana'
import { Modal } from './modal'
import { WalletAddress } from './wallet-address'

export function DepositModal({
  open,
  onClose,
  walletAddress,
}: {
  open: boolean
  onClose: () => void
  walletAddress: string
}) {
  const { state, copy } = useCopy(walletAddress)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Deposit USDC"
      detail={NETWORK.label}
    >
      <div className="flex flex-col items-center">
        {/* Encode the full receiving address, never its display abbreviation. */}
        <QRCodeSVG
          value={walletAddress}
          size={224}
          level="M"
          marginSize={4}
          bgColor="#ffffff"
          fgColor="#000000"
          title="Scan this wallet address to deposit USDC"
          className="h-auto max-w-full rounded-[9px]"
        />
        <p className="mt-3 text-center text-[13px] text-fg-2">
          Scan with Phantom or another Solana wallet.
        </p>
      </div>
      <div className="mt-5">
        <p className="d-label mb-2">Wallet address</p>
        <WalletAddress walletAddress={walletAddress} />
      </div>
      <button
        type="button"
        className="d-btn d-btn-primary mt-3 h-11 w-full"
        onClick={() => void copy()}
      >
        <CopyIcon size={18} aria-hidden="true" />
        {copyLabel(state, 'Copy address')}
      </button>
      <CopyStatus state={state} subject="address" />
      {state === 'failed' && (
        <p className="mt-2 text-[12.5px] text-bad">
          Copy failed. Select the address and copy it manually.
        </p>
      )}
      <p className="mt-4 text-[12.5px] leading-5 text-fg-2">
        Only send USDC on {NETWORK.label}.
      </p>
      <p className="mt-1 text-[12.5px] leading-5 text-fg-3">
        Your balance updates after the transfer confirms.
      </p>
    </Modal>
  )
}
