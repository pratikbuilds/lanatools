import { AnimatedCounter } from '#/components/ui/animated-counter'
import { formatSol } from '#/lib/units'
import { selectedNetwork } from '#/lib/networks'
import { Skeleton } from './skeleton'
import { SolanaShine } from './solana-shine'
import { SplitPanel } from './split-panel'
import { WalletAddress } from './wallet-address'

const NETWORK_LABEL = selectedNetwork().label

/** USDC base units as dollars, cut to whole cents and never rounded up. */
function wholeCents(usdc: bigint) {
  return Number(usdc / 10_000n) / 100
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
              Send USDC on {NETWORK_LABEL}, plus a little SOL for withdrawal
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
