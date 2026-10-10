import { useCreateWallet } from '@privy-io/react-auth/solana'
import { address } from '@solana/kit'
import { skipToken, useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AnimatedCounter } from '#/components/ui/animated-counter'
import { NETWORK, formatSol, getWalletBalances } from '#/lib/solana'
import { DepositModal } from './deposit-modal'
import { WalletAddress } from './wallet-address'
import { SolanaShine } from './solana-shine'
import { SplitPanel } from './split-panel'
import { useDashboardSession } from './session'
import { WithdrawModal } from './withdraw-modal'
import { Skeleton } from './skeleton'

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
          balances={balances.data ?? null}
          loadFailed={balances.isError}
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
  walletAddress: string | null
  balances: { usdc: bigint; sol: bigint } | undefined
  pending: boolean
  failed: boolean
  onDeposit: () => void
  onWithdraw: () => void
}) {
  return (
    <section className="mt-5" aria-label="Payment wallet" aria-busy={pending}>
      {pending && (
        <p role="status" className="sr-only">
          Loading balances…
        </p>
      )}
      <SplitPanel
        left={
          <>
            <p className="d-label">Available</p>
            <p className="mt-4 mb-3 flex flex-wrap items-baseline font-mono text-[clamp(1.75rem,8vw,2.75rem)] leading-none font-semibold tracking-[-0.05em] sm:text-[58px]">
              {balances ? (
                <AnimatedCounter
                  value={wholeCents(balances.usdc)}
                  decimals={2}
                  prefix="$"
                  className="max-w-full overflow-x-auto"
                />
              ) : pending ? (
                <span
                  aria-hidden="true"
                  className="relative inline-flex items-center leading-[1.5]"
                >
                  <span className="invisible">$0.00</span>
                  <Skeleton className="absolute top-1/2 left-0 h-[0.95em] w-full -translate-y-1/2" />
                </span>
              ) : (
                <span>—</span>
              )}
              <small className="ml-2.5 text-[14px] font-medium tracking-normal text-fg-3">
                USDC
              </small>
              {balances ? (
                <FeeBalance sol={balances.sol} />
              ) : (
                pending && (
                  <small className="ml-2.5 text-[14px] font-medium tracking-normal text-fg-3">
                    <span aria-hidden="true" className="mr-2.5">
                      ·
                    </span>
                    <Skeleton className="inline-block h-3.5 w-16 align-middle" />
                  </small>
                )
              )}
            </p>
            <p className="max-w-[330px] text-fg-2 lg:pr-16">
              Your connected clients pay for tools from this balance, each
              within its own limit.
            </p>
            <p
              role="alert"
              className="mt-2 text-[12.5px] text-bad empty:hidden"
            >
              {failed ? 'Could not load balances.' : ''}
            </p>
            <span className="absolute right-[22px] bottom-[18px] text-fg max-lg:hidden">
              <SolanaShine size={64} />
            </span>
          </>
        }
        right={
          <>
            <h2 className="d-label">Deposit USDC</h2>
            <div className="mt-3 w-full max-w-[30rem]">
              {walletAddress ? (
                <WalletAddress walletAddress={walletAddress} compact />
              ) : (
                <div className="flex h-[50px] items-center rounded-[9px] border border-line-2 bg-panel-2/40 px-3.5">
                  <Skeleton className="h-4 w-48 max-w-full" />
                </div>
              )}
            </div>
            <p className="mt-3 text-[12.5px] text-fg-3">
              Send USDC on {NETWORK.label}, plus a little SOL for withdrawal
              fees. You can withdraw other tokens held on this network.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="d-btn d-btn-primary"
                disabled={!walletAddress}
                onClick={onDeposit}
              >
                <span aria-hidden="true">↓</span> Deposit
              </button>
              <button
                type="button"
                className="d-btn"
                disabled={!walletAddress}
                onClick={onWithdraw}
              >
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
      className={`ml-2.5 text-[14px] font-medium tracking-normal ${empty ? 'text-bad' : 'text-fg-3'}`}
    >
      <span aria-hidden="true" className="mr-2.5 text-fg-3">
        ·
      </span>
      {`${formatSol(sol)} SOL`}
    </small>
  )
}
