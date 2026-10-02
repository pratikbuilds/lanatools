import { useCreateWallet } from '@privy-io/react-auth/solana'
import { address } from '@solana/kit'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AnimatedCounter } from '#/components/ui/animated-counter'
import { CopyStatus, copyLabel, useCopy } from '#/components/landing/copy-url'
import {
  NETWORK,
  SOL_DECIMALS,
  formatUnits,
  getWalletBalances,
} from '#/lib/solana'
import { Drawer, DrawerFacts, DrawerHeader } from './drawer'

export function CreateWallet() {
  const { createWallet } = useCreateWallet()
  const create = useMutation({ mutationFn: () => createWallet() })

  return (
    <section className="mt-6 rounded-[10px] border-[1.5px] border-ink bg-card px-6 py-8 sm:px-8">
      <h2 className="title text-[1.6rem]">Create your payment wallet</h2>
      <p className="mt-3 text-[14px] text-mute">
        Your agents pay from this Solana wallet, never from the wallet you sign
        in with.
      </p>
      <button
        type="button"
        className="btn btn-flat btn-primary mt-6 disabled:cursor-wait"
        disabled={create.isPending}
        onClick={() => create.mutate()}
      >
        {create.isPending ? 'Creating…' : 'Create wallet'}
      </button>
      <p role="alert" className="mt-3 text-[13px] text-coral-ink empty:hidden">
        {create.isError ? 'Could not create the wallet. Try again.' : ''}
      </p>
    </section>
  )
}

/**
 * The wallet's balances, refreshed while the page is open. Nothing is read
 * until the user has a wallet.
 */
export function useWalletBalances(walletAddress: string | null) {
  return useQuery({
    queryKey: ['balances', NETWORK.id, walletAddress],
    queryFn: walletAddress
      ? () => getWalletBalances(address(walletAddress))
      : skipToken,
    refetchInterval: 15_000,
  })
}

/** USDC base units as dollars, cut to whole cents and never rounded up. */
function wholeCents(usdc: bigint) {
  return Number(usdc / 10_000n) / 100
}

/**
 * The balance and the way to add to it, as one panel: what is available on
 * the left, the wallet's address and Deposit on the right.
 */
export function WalletPanel({ walletAddress }: { walletAddress: string }) {
  const { state, copy } = useCopy(walletAddress)
  const balances = useWalletBalances(walletAddress)
  const [depositing, setDepositing] = useState(false)

  return (
    <section className="mt-6 grid overflow-hidden rounded-[10px] border-[1.5px] border-ink bg-card md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="min-w-0 px-6 py-6 sm:px-7">
        <p className="text-[12px] text-mute">Available</p>
        <p className="mt-2.5 mb-4 flex items-baseline gap-2.5 text-[3.4rem] leading-[0.95] font-bold tracking-[-0.05em] sm:text-[4.4rem]">
          {balances.data ? (
            <AnimatedCounter
              value={wholeCents(balances.data.usdc)}
              decimals={2}
            />
          ) : (
            <span
              className={
                balances.isPending
                  ? 'h-[0.95em] w-[2.6em] animate-pulse rounded-[8px] bg-paper'
                  : ''
              }
            >
              {balances.isPending ? '' : '—'}
            </span>
          )}
          <span className="text-[14px] tracking-normal text-mute">USDC</span>
        </p>
        <span className="inline-flex h-[22px] items-center gap-1.5 rounded-full border border-rule px-2 text-[11.5px] whitespace-nowrap text-mute">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-coral" />
          {NETWORK.label}
        </span>
        <p
          role="alert"
          className="mt-2 text-[12.5px] text-coral-ink empty:hidden"
        >
          {balances.isError ? 'Could not load balances.' : ''}
        </p>
      </div>

      <div className="min-w-0 border-t-[1.5px] border-ink bg-paper px-6 py-6 sm:px-7 md:border-t-0 md:border-l-[1.5px]">
        <h2 className="text-[15px] font-bold">Deposit USDC</h2>
        <p className="mt-2.5 mb-3.5 text-[12px] text-mute">
          Send USDC on {NETWORK.label} to your wallet address.
        </p>
        <div className="flex items-center gap-2 rounded-[8px] border-[1.5px] border-ink bg-paper py-[5px] pr-[5px] pl-3">
          <code
            title={walletAddress}
            className="min-w-0 flex-1 truncate font-semibold"
          >
            {walletAddress}
          </code>
          <button
            type="button"
            onClick={() => void copy()}
            className="btn btn-flat h-7 px-2.5 text-[12px]"
            aria-label="Copy the deposit address"
          >
            {copyLabel(state, 'Copy')}
          </button>
          <CopyStatus state={state} subject="address" />
        </div>
        <button
          type="button"
          className="btn btn-flat btn-primary mt-3.5"
          onClick={() => setDepositing(true)}
        >
          Deposit
        </button>
      </div>

      <Drawer
        open={depositing}
        onClose={() => setDepositing(false)}
        label="Deposit USDC"
      >
        <DrawerHeader
          title="Deposit USDC"
          detail={`Your wallet on ${NETWORK.label}`}
          onClose={() => setDepositing(false)}
        />
        <p>
          Send USDC on {NETWORK.label} to this address. It shows up in your
          balance once the transfer confirms.
        </p>
        <p className="my-3.5 rounded-[8px] border-[1.5px] border-ink bg-paper px-3.5 py-3 font-bold break-all">
          {walletAddress}
        </p>
        <button
          type="button"
          className="btn btn-flat btn-primary"
          onClick={() => void copy()}
        >
          {copyLabel(state, 'Copy address')}
        </button>
        <DrawerFacts
          facts={[
            ['Network', NETWORK.label],
            [
              'Network fees',
              balances.data
                ? `${formatUnits(balances.data.sol, SOL_DECIMALS, { maxFraction: 4 })} SOL in this wallet`
                : '—',
            ],
          ]}
        />
      </Drawer>
    </section>
  )
}
