import { useSignTransaction, useWallets } from '@privy-io/react-auth/solana'
import { isAddress } from '@solana/kit'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { NETWORK, USDC_DECIMALS, formatUnits } from '#/lib/solana'
import {
  formatUsdcAmount,
  parseUsdcAmount,
  withdrawUsdc,
} from '#/lib/withdrawals'
import type { SignTransaction } from '#/lib/withdrawals'
import { Modal } from './modal'
import { useDashboardSession } from './session'

/**
 * Signs with the payment wallet through the user's own Privy session. The
 * wallet is only connected once Privy is ready, so this is null until then.
 */
function useWalletSigner(walletAddress: string): SignTransaction | null {
  const { wallets } = useWallets()
  const { signTransaction } = useSignTransaction()
  const wallet = wallets.find((w) => w.address === walletAddress)
  if (!wallet) return null
  // The modal is already the confirmation: the user typed the address and
  // amount and pressed Withdraw. Privy's own prompt would also sit behind
  // this native modal dialog, where it cannot be clicked.
  return async (transaction) =>
    (
      await signTransaction({
        transaction,
        wallet,
        chain: NETWORK.chain,
        options: { uiOptions: { showWalletUIs: false } },
      })
    ).signedTransaction
}

export type Balances = { usdc: bigint; sol: bigint }

/**
 * What is wrong with the form, or null when it can be sent. Nothing can be
 * sent until the balances have loaded: they prove the API reads the network
 * this page names, and the amount is checked against them.
 */
export function checkForm(
  { to, amount }: { to: string; amount: string },
  walletAddress: string,
  balances: Balances | null,
) {
  if (!to || !amount || !balances) return 'incomplete'
  if (!isAddress(to)) return 'Enter a valid Solana address.'
  if (to === walletAddress) return 'Enter an address other than this wallet.'
  const units = parseUsdcAmount(amount)
  if (units === null) return 'Enter an amount in USDC, up to six decimals.'
  if (units > balances.usdc) return 'That is more than the wallet holds.'
  return null
}

/**
 * Whether the wallet can pay the network fee. The fee comes out of its own
 * SOL, so with none a withdrawal is certain to fail and the form is held.
 * It is also held while the balances are unknown.
 */
export function feeNote(balances: Balances | null, loadFailed: boolean) {
  if (!balances)
    return {
      blocked: true,
      text: loadFailed
        ? 'The wallet balances could not be loaded. Close this and try again.'
        : 'Checking the wallet balances…',
    }
  if (balances.sol === 0n)
    return {
      blocked: true,
      text: 'This wallet has no SOL to pay the network fee. Add SOL to it first.',
    }
  return {
    blocked: false,
    text: 'The network fee is paid in SOL from this wallet.',
  }
}

/**
 * Withdraws USDC to another address, in a centred modal. The transfer is
 * built by the API, signed by the user's wallet here and sent by the API.
 * Mount it to open it; unmounting clears the form and the last result.
 */
export function WithdrawModal({
  onClose,
  walletAddress,
  balances,
  loadFailed,
}: {
  onClose: () => void
  walletAddress: string
  /** USDC base units and lamports, or null while they are unknown. */
  balances: Balances | null
  /** Whether the balances failed to load, as opposed to still loading. */
  loadFailed: boolean
}) {
  const { getAccessToken } = useDashboardSession()
  const sign = useWalletSigner(walletAddress)
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ to: '', amount: '' })
  const withdraw = useMutation({
    mutationFn: (request: { to: string; amount: bigint }) => {
      if (!sign) throw new Error('Your wallet is still connecting. Try again.')
      return withdrawUsdc(
        getAccessToken,
        {
          owner: walletAddress,
          to: request.to,
          amount: String(request.amount),
        },
        sign,
      )
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['balances', NETWORK.id] }),
  })

  const problem = checkForm(form, walletAddress, balances)
  const fee = feeNote(balances, loadFailed)
  const canSubmit = problem === null && !fee.blocked && !withdraw.isPending
  const available = balances?.usdc ?? null

  return (
    <Modal
      open
      onClose={onClose}
      // Closing midway would lose the withdrawal's state while it still
      // completes, and a reopened form would let the same one be sent twice.
      closable={!withdraw.isPending}
      title="Withdraw USDC"
      detail={`From your wallet on ${NETWORK.label}`}
    >
      {withdraw.isSuccess ? (
        <Sent
          amount={withdraw.variables.amount}
          to={withdraw.variables.to}
          signature={withdraw.data.signature}
          confirmed={withdraw.data.confirmed}
          onDone={onClose}
        />
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            const amount = parseUsdcAmount(form.amount)
            if (canSubmit && amount !== null)
              withdraw.mutate({ to: form.to, amount })
          }}
        >
          <label className="grid gap-1.5">
            <span className="d-label">To address</span>
            <input
              className="d-input h-10 font-mono"
              placeholder="Solana address"
              value={form.to}
              onChange={(event) =>
                setForm({ ...form, to: event.target.value.trim() })
              }
              autoComplete="off"
              spellCheck={false}
              disabled={withdraw.isPending}
            />
          </label>
          <label className="grid gap-1.5">
            <span className="flex items-baseline justify-between">
              <span className="d-label">Amount</span>
              <span className="font-mono text-[12px] text-fg-3">
                {available === null
                  ? '—'
                  : `$${formatUnits(available, USDC_DECIMALS, { maxFraction: 2, minFraction: 2 })} available`}
              </span>
            </span>
            <span className="flex gap-2">
              <input
                className="d-input h-10 min-w-0 flex-1 font-mono"
                inputMode="decimal"
                placeholder="0.00"
                value={form.amount}
                onChange={(event) =>
                  setForm({ ...form, amount: event.target.value })
                }
                disabled={withdraw.isPending}
              />
              <button
                type="button"
                className="d-btn h-10"
                disabled={!available || withdraw.isPending}
                onClick={() =>
                  available &&
                  setForm({ ...form, amount: formatUsdcAmount(available) })
                }
              >
                Max
              </button>
            </span>
          </label>
          <button
            type="submit"
            className="d-btn d-btn-primary h-11 disabled:cursor-wait"
            disabled={!canSubmit}
          >
            {withdraw.isPending ? 'Sending…' : 'Withdraw'}
          </button>
          <p role="alert" className="text-[12.5px] text-bad empty:hidden">
            {withdraw.isError
              ? withdraw.error.message
              : problem && problem !== 'incomplete'
                ? problem
                : ''}
          </p>
          <p
            className={`text-[12.5px] ${fee.blocked ? 'text-bad' : 'text-fg-3'}`}
          >
            {fee.text}
          </p>
          <p className="text-[12.5px] text-fg-3">
            Only send to an address on {NETWORK.label}.
          </p>
        </form>
      )}
    </Modal>
  )
}

/** The sent transfer, with its signature for the explorer. */
function Sent({
  amount,
  to,
  signature,
  confirmed,
  onDone,
}: {
  amount: bigint
  to: string
  signature: string
  confirmed: boolean
  onDone: () => void
}) {
  const explorer = `https://explorer.solana.com/tx/${signature}${NETWORK.id === 'mainnet' ? '' : `?cluster=${NETWORK.id}`}`
  return (
    <div className="grid gap-4">
      <div>
        <p className="d-label">Sent</p>
        <p className="mt-2 font-mono text-[1.6rem] font-semibold tracking-[-0.03em]">
          ${formatUsdcAmount(amount)}{' '}
          <small className="text-[14px] font-medium tracking-normal text-fg-3">
            USDC
          </small>
        </p>
        <p className="mt-2 text-[13px] text-fg-2">To</p>
        <code className="block font-mono text-[12.5px] break-all">{to}</code>
      </div>
      <p className="text-[12.5px] text-fg-3">
        {confirmed
          ? 'Confirmed by the network.'
          : 'Accepted by the network; the balance updates once it confirms.'}{' '}
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-fg"
        >
          View the transaction
        </a>
      </p>
      <button
        type="button"
        className="d-btn d-btn-primary h-11"
        onClick={onDone}
      >
        Done
      </button>
    </div>
  )
}
