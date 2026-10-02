import { LatestActivity } from './activity'
import { ConnectedClients } from './connected-clients'
import { useDashboardSession } from './session'
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
      <h1 className="pt-9 text-[22px] font-bold tracking-[-0.03em]">Wallet</h1>
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
