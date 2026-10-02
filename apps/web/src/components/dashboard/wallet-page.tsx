import { ConnectedClients } from './connected-clients'
import { useDashboardSession } from './session'
import { CreateWallet, WalletPanel } from './wallet-panel'

/** The dashboard's home: the wallet, then the clients that draw from it. */
export function WalletPage() {
  const { walletAddress } = useDashboardSession()
  return (
    <>
      <h1 className="pt-9 text-[22px] font-bold tracking-[-0.03em]">Wallet</h1>
      {walletAddress ? (
        <WalletPanel walletAddress={walletAddress} />
      ) : (
        <CreateWallet />
      )}
      <ConnectedClients />
    </>
  )
}
