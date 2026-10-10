import { useState } from 'react'
import type { AgentId } from '#/components/landing/logos'
import { NETWORK } from '#/lib/solana'
import { LatestActivity } from './activity'
import { ConnectClientModal, DEFAULT_CLIENT } from './connect-client'
import { ConnectedClients } from './connected-clients'
import { PageHead } from './page-head'
import { useDashboardSession } from './session'
import { SolanaMark } from './solana-mark'
import { CreateWallet, WalletPanel } from './wallet-panel'

/**
 * The dashboard's home, in the order the data nests: the wallet, the clients
 * that draw from it, then the latest calls those clients made.
 */
export function WalletPage({
  onViewActivity,
}: {
  /** Opens the Activity page, for one client or for all of them. */
  onViewActivity: (clientId: string | undefined) => void
}) {
  const { walletAddress } = useDashboardSession()
  // The client the setup is open on; closed when there is none.
  const [connecting, setConnecting] = useState<AgentId | null>(null)
  return (
    <>
      <WalletPageHead onConnect={() => setConnecting(DEFAULT_CLIENT)} />
      {walletAddress ? (
        <WalletPanel walletAddress={walletAddress} />
      ) : (
        <CreateWallet />
      )}
      <ConnectedClients
        onViewActivity={onViewActivity}
        onConnect={setConnecting}
      />
      <LatestActivity onViewAll={() => onViewActivity(undefined)} />
      <ConnectClientModal
        client={connecting}
        onClose={() => setConnecting(null)}
      />
    </>
  )
}

export function WalletPageHead({ onConnect }: { onConnect?: () => void }) {
  return (
    <PageHead title="Wallet">
      <span className="d-chip">
        <SolanaMark />
        {NETWORK.label}
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
