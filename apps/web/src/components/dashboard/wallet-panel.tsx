import { useCreateWallet } from '@privy-io/react-auth/solana'
import { address } from '@solana/kit'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AnimatedCounter } from '#/components/ui/animated-counter'
import { NETWORK, formatSol, getWalletBalances } from '#/lib/solana'
import { DepositModal } from './deposit-modal'
import { WalletAddress } from './wallet-address'
import { SolanaCoin } from './solana-mark'
import { SolanaShine } from './solana-shine'
import { SplitPanel } from './split-panel'
import { useDashboardSession } from './session'
import { WithdrawModal } from './withdraw-modal'

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

/** USDC base units as dollars, cut to whole cents and never rounded up. */
function wholeCents(usdc: bigint) {
  return Number(usdc / 10_000n) / 100
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
          available={balances.data?.usdc ?? null}
          sol={balances.data?.sol ?? null}
        />
      )}
    </>
  )
}

/**
 * One panel: what is available on the left, the wallet's address with
 * Deposit and Withdraw on the right. USDC is the figure; the SOL that pays
 * withdrawal fees sits beside it in small type, so nobody meets the fee for
 * the first time as a failure.
 */
export function WalletPanelView({
  walletAddress,
  balances,
  pending,
  failed,
  onDeposit,
  onWithdraw,
}: {
  walletAddress: string
  balances: { usdc: bigint; sol: bigint } | undefined
  pending: boolean
  failed: boolean
  onDeposit: () => void
  onWithdraw: () => void
}) {
  return (
    <section className="mt-5">
      <SplitPanel
        left={
          <>
            <p className="d-label">Available</p>
            <p className="mt-4 mb-3 flex flex-wrap items-baseline font-mono text-[44px] leading-none font-semibold tracking-[-0.05em] sm:text-[58px]">
              {balances ? (
                <AnimatedCounter
                  value={wholeCents(balances.usdc)}
                  decimals={2}
                  prefix="$"
                />
              ) : (
                <span
                  className={
                    pending
                      ? 'h-[0.95em] w-[3em] animate-pulse rounded-[8px] bg-panel-2'
                      : ''
                  }
                >
                  {pending ? '' : '—'}
                </span>
              )}
              <small className="ml-2.5 text-[14px] font-medium tracking-normal text-fg-3">
                USDC
              </small>
              {balances && <FeeBalance sol={balances.sol} />}
            </p>
            <p className="max-w-[330px] text-fg-2">
              Your connected clients pay for tools from this balance, each
              within its own limit.
            </p>
            <p
              role="alert"
              className="mt-2 text-[12.5px] text-bad empty:hidden"
            >
              {failed ? 'Could not load balances.' : ''}
            </p>
            <span className="absolute right-[22px] bottom-[18px] text-fg">
              <SolanaShine size={64} />
            </span>
          </>
        }
        right={
          <>
            <h2 className="d-label">Deposit USDC</h2>
            <div className="mt-3 w-full max-w-[30rem]">
              <WalletAddress walletAddress={walletAddress} compact />
            </div>
            <p className="mt-3 text-[12.5px] text-fg-3">
              Send USDC on {NETWORK.label}, plus a little SOL for withdrawal
              fees. Other tokens or networks won’t show up.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="d-btn d-btn-primary"
                onClick={onDeposit}
              >
                <span aria-hidden="true">↓</span> Deposit
              </button>
              <button type="button" className="d-btn" onClick={onWithdraw}>
                <span aria-hidden="true">↑</span> Withdraw
              </button>
            </div>
          </>
        }
      />
    </section>
  )
}

/**
 * The SOL that pays withdrawal fees, beside the balance in the same small
 * type as its unit. A wallet with none is told here, in red, before it
 * tries to withdraw.
 */
function FeeBalance({ sol }: { sol: bigint }) {
  const empty = sol === 0n
  return (
    <small
      title={
        empty
          ? 'Add SOL to this wallet to withdraw.'
          : 'Pays the network fee when you withdraw.'
      }
      className={`ml-3.5 text-[14px] font-medium tracking-normal ${empty ? 'text-bad' : 'text-fg-3'}`}
    >
      <SolanaCoin size={14} className="mr-1.5 align-[-2px]" />
      {`${formatSol(sol)} SOL`}
    </small>
  )
}
