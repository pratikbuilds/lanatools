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
import { Modal } from './modal'
import { SolanaShine } from './solana-shine'
import { SplitPanel } from './split-panel'
import { useDashboardSession } from './session'

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

/** A wallet address cut to its first and last four characters. */
function shortAddress(walletAddress: string) {
  return `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`
}

/**
 * The balance and the ways to move it, as one panel: what is available on
 * the left, the wallet's address with Deposit and Withdraw on the right.
 */
export function WalletPanel({ walletAddress }: { walletAddress: string }) {
  const { state, copy } = useCopy(walletAddress)
  const balances = useWalletBalances(walletAddress)
  const [depositing, setDepositing] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  return (
    <section className="mt-5">
      <SplitPanel
        left={
          <>
            <p className="d-label">Available</p>
            <p className="mt-4 mb-3 flex items-baseline font-mono text-[44px] leading-none font-semibold tracking-[-0.05em] sm:text-[58px]">
              {balances.data ? (
                <AnimatedCounter
                  value={wholeCents(balances.data.usdc)}
                  decimals={2}
                  prefix="$"
                />
              ) : (
                <span
                  className={
                    balances.isPending
                      ? 'h-[0.95em] w-[3em] animate-pulse rounded-[8px] bg-panel-2'
                      : ''
                  }
                >
                  {balances.isPending ? '' : '—'}
                </span>
              )}
              <small className="ml-2.5 text-[14px] font-medium tracking-normal text-fg-3">
                USDC
              </small>
            </p>
            <p className="max-w-[330px] text-fg-2">
              Your connected clients pay for tools from this balance, each
              within its own limit.
            </p>
            <p
              role="alert"
              className="mt-2 text-[12.5px] text-bad empty:hidden"
            >
              {balances.isError ? 'Could not load balances.' : ''}
            </p>
            <span className="absolute right-[22px] bottom-[18px] text-fg">
              <SolanaShine size={64} />
            </span>
          </>
        }
        right={
          <>
            <h2 className="d-label">Deposit USDC</h2>
            <div className="mt-3 flex items-center gap-2">
              <code title={walletAddress} className="d-well">
                {shortAddress(walletAddress)}
              </code>
              <button
                type="button"
                onClick={() => void copy()}
                className="d-btn h-[39px]"
                aria-label="Copy the wallet address"
              >
                {copyLabel(state, 'Copy')}
              </button>
              <CopyStatus state={state} subject="address" />
            </div>
            <p className="mt-3 text-[12.5px] text-fg-3">
              Only send USDC on {NETWORK.label}. Other tokens or networks won’t
              show up.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="d-btn d-btn-primary"
                onClick={() => setDepositing(true)}
              >
                <span aria-hidden="true">↓</span> Deposit
              </button>
              <button
                type="button"
                className="d-btn"
                onClick={() => setWithdrawing(true)}
              >
                <span aria-hidden="true">↑</span> Withdraw
              </button>
            </div>
          </>
        }
      />

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
        <p className="d-well my-3.5">{walletAddress}</p>
        <button
          type="button"
          className="d-btn d-btn-primary"
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

      <WithdrawModal
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        available={balances.data ? wholeCents(balances.data.usdc) : null}
      />
    </section>
  )
}

/**
 * Where a withdrawal will be filled in, in a centred modal. Sending is not built yet, so the
 * form can be filled but not submitted.
 */
function WithdrawModal({
  open,
  onClose,
  available,
}: {
  open: boolean
  onClose: () => void
  available: number | null
}) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Withdraw USDC"
      detail={`From your wallet on ${NETWORK.label}`}
    >
      <form className="grid gap-4" onSubmit={(event) => event.preventDefault()}>
        <label className="grid gap-1.5">
          <span className="d-label">To address</span>
          <input
            className="d-input h-10 font-mono"
            placeholder="Solana address"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5">
          <span className="flex items-baseline justify-between">
            <span className="d-label">Amount</span>
            <span className="font-mono text-[12px] text-fg-3">
              {available === null ? '—' : `$${available.toFixed(2)} available`}
            </span>
          </span>
          <span className="flex gap-2">
            <input
              className="d-input h-10 min-w-0 flex-1 font-mono"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <button
              type="button"
              className="d-btn h-10"
              disabled={available === null}
              onClick={() =>
                available !== null && setAmount(available.toFixed(2))
              }
            >
              Max
            </button>
          </span>
        </label>
        <button type="submit" className="d-btn d-btn-primary h-11" disabled>
          Withdraw
        </button>
        <p className="text-[12.5px] text-fg-3">
          Withdrawals are coming soon. Nothing is sent from this form yet.
        </p>
      </form>
    </Modal>
  )
}
