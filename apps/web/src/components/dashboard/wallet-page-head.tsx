import { selectedNetwork } from '#/lib/networks'
import { PageHead } from './page-head'
import { SolanaMark } from './solana-mark'

export function WalletPageHead({ onConnect }: { onConnect?: () => void }) {
  return (
    <PageHead title="Wallet">
      <span className="d-chip">
        <SolanaMark />
        {selectedNetwork().label}
      </span>
      <button
        type="button"
        className="d-btn sm:ml-auto"
        disabled={!onConnect}
        onClick={onConnect}
      >
        <span aria-hidden="true">＋</span> Connect a client
      </button>
    </PageHead>
  )
}
