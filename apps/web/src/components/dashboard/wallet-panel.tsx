import { useCreateWallet } from '@privy-io/react-auth/solana'
import { address } from '@solana/kit'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CopyStatus, copyLabel, useCopy } from '#/components/landing/copy-url'
import {
  NETWORK,
  SOL_DECIMALS,
  USDC_DECIMALS,
  formatUnits,
  getWalletBalances,
} from '#/lib/solana'
import { SolIcon, UsdcIcon } from './token-icons'

export function CreateWallet() {
  const { createWallet } = useCreateWallet()
  const create = useMutation({ mutationFn: () => createWallet() })

  return (
    <section className="box box-lg px-6 py-8 sm:px-8">
      <h1 className="title text-[1.6rem]">Create your payment wallet</h1>
      <p className="mt-3 text-[14px] text-mute">
        Your agents pay from this Solana wallet, never from the wallet you sign
        in with.
      </p>
      <button
        type="button"
        className="btn btn-primary mt-6 disabled:cursor-wait"
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

export function PaymentWallet({ walletAddress }: { walletAddress: string }) {
  const { state, copy } = useCopy(walletAddress)
  const balances = useQuery({
    queryKey: ['balances', NETWORK.id, walletAddress],
    queryFn: () => getWalletBalances(address(walletAddress)),
    refetchInterval: 15_000,
  })
  const usdc = balances.data
    ? formatUnits(balances.data.usdc, USDC_DECIMALS, {
        maxFraction: 2,
        minFraction: 2,
      })
    : '—'
  const sol = balances.data
    ? formatUnits(balances.data.sol, SOL_DECIMALS, { maxFraction: 4 })
    : '—'

  return (
    <section className="box box-lg px-6 py-7 sm:px-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-[15px] font-bold">Payment wallet</h1>
        <span className="chip gap-1.5">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-coral" />
          {NETWORK.label}
        </span>
      </div>

      <div className="mt-7 flex items-center gap-3">
        <UsdcIcon size={40} />
        {balances.isPending ? (
          <span className="h-12 w-36 animate-pulse rounded-[8px] bg-paper" />
        ) : (
          <p className="text-[3rem] leading-none font-bold tracking-tight">
            {usdc}
          </p>
        )}
        <span className="self-end pb-1 text-[15px] font-bold text-mute">
          USDC
        </span>
      </div>
      <p className="mt-3 text-[13.5px] text-mute">
        Available for your agents to spend
      </p>

      <p className="mt-5 flex items-center gap-2 border-y border-rule py-3 text-[12.5px] text-mute">
        <SolIcon size={18} />
        <span className="font-semibold text-ink">{sol} SOL</span>
        for network fees
      </p>
      <p
        role="alert"
        className="mt-2 text-[12.5px] text-coral-ink empty:hidden"
      >
        {balances.isError ? 'Could not load balances.' : ''}
      </p>

      <p className="mt-6 text-[12.5px] font-semibold text-mute">Deposit USDC</p>
      <div className="mt-2 flex items-center gap-2 rounded-[8px] border-[1.5px] border-ink bg-paper py-1.5 pr-1.5 pl-3.5">
        <code className="min-w-0 flex-1 text-[13.5px] leading-5 font-semibold break-all">
          {walletAddress}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="btn btn-sm size-8 shrink-0 px-0"
          aria-label="Copy the deposit address"
          title={copyLabel(state, 'Copy address')}
        >
          {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
        </button>
        <CopyStatus state={state} subject="address" />
      </div>
      <p className="mt-3 text-[12.5px] leading-5 text-mute">
        Send USDC on Solana to this address. Keep a little SOL here for network
        fees.
      </p>
    </section>
  )
}

function CopyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect
        x="5.5"
        y="5.5"
        width="8.5"
        height="8.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="shrink-0"
    >
      <path
        d="M3 8.5 6.5 12 13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
