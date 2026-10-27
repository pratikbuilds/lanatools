import { useCreateWallet } from '@privy-io/react-auth/solana'
import { address } from '@solana/kit'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { NETWORK, getWalletBalances } from '#/lib/solana'
import { DepositModal } from './deposit-modal'
import { useDashboardSession } from './session'
import { WalletPanelView } from './wallet-panel-view'
import { WithdrawModal } from './withdraw-modal'

export { WalletPanelView } from './wallet-panel-view'

export function CreateWallet() {
  const { createWallet } = useCreateWallet()
  const create = useMutation({ mutationFn: () => createWallet() })

  return (
    <section className="d-frame mt-5">
      <div className="d-inset px-6 py-8 sm:px-7">
        <p className="d-label">Payment wallet</p>
        <h2 className="mt-3 font-mono text-[1.4rem] font-semibold tracking-[-0.03em]">
          Create your payment wallet
        </h2>
        <p className="mt-2 max-w-[34rem] text-fg-2">
          Your agents pay from this Solana wallet, never from the wallet you
          sign in with.
        </p>
        <button
          type="button"
          className="d-btn d-btn-primary mt-6 disabled:cursor-wait"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creating…' : 'Create wallet'}
        </button>
        <p role="alert" className="mt-3 text-[13px] text-bad empty:hidden">
          {create.isError ? 'Could not create the wallet. Try again.' : ''}
        </p>
      </div>
    </section>
  )
}

/**
 * The wallet's balances, refreshed while the page is open. Nothing is read
 * until the user has a wallet.
 */
export function useWalletBalances(walletAddress: string | null) {
  const { getAccessToken } = useDashboardSession()
  return useQuery({
    queryKey: ['balances', NETWORK.id, walletAddress],
    queryFn: walletAddress
      ? () => getWalletBalances(getAccessToken, address(walletAddress))
      : skipToken,
    refetchInterval: 15_000,
  })
}

/** The balance and the ways to move it, for the signed-in user's wallet. */
export function WalletPanel({ walletAddress }: { walletAddress: string }) {
  const balances = useWalletBalances(walletAddress)
  const [depositing, setDepositing] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  return (
    <>
      <WalletPanelView
        walletAddress={walletAddress}
        balances={balances.data}
        pending={balances.isPending}
        failed={balances.isError}
        onDeposit={() => setDepositing(true)}
        onWithdraw={() => setWithdrawing(true)}
      />
      <DepositModal
        open={depositing}
        onClose={() => setDepositing(false)}
        walletAddress={walletAddress}
      />
      {withdrawing && (
        <WithdrawModal
          onClose={() => setWithdrawing(false)}
          walletAddress={walletAddress}
          balances={balances.data ?? null}
          loadFailed={balances.isError}
        />
      )}
    </>
  )
}
