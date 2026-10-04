import { NETWORK } from '#/lib/solana'
import { LatestActivity } from './activity'
import { ConnectClientButton } from './connect-client'
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
  return (
    <>
      <PageHead title="Wallet">
        <span className="d-chip">
          <SolanaMark />
          {NETWORK.label}
        </span>
        <div className="sm:ml-auto">
          <ConnectClientButton />
        </div>
      </PageHead>
      {walletAddress ? (
        <WalletPanel walletAddress={walletAddress} />
      ) : (
        <CreateWallet />
      )}
      <ConnectedClients onViewActivity={onViewActivity} />
      <LatestActivity onViewAll={() => onViewActivity(undefined)} />
    </>
  )
}
