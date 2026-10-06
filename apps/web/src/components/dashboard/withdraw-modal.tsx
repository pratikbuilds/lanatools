import { useSignTransaction, useWallets } from '@privy-io/react-auth/solana'
import { isAddress } from '@solana/kit'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { NETWORK, formatUnits, USDC_DECIMALS } from '#/lib/solana'
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

/** What is wrong with the form, or null when it can be sent. */
function checkForm(
  { to, amount }: { to: string; amount: string },
  walletAddress: string,
  available: bigint | null,
) {
  if (!to || !amount) return 'incomplete'
  if (!isAddress(to)) return 'Enter a valid Solana address.'
  if (to === walletAddress) return 'Enter an address other than this wallet.'
  const units = parseUsdcAmount(amount)
  if (units === null) return 'Enter an amount in USDC, up to six decimals.'
  if (available !== null && units > available)
    return 'That is more than the wallet holds.'
  return null
}

/**
 * Withdraws USDC to another address, in a centred modal. The transfer is
 * built by the API, signed by the user's wallet here and sent by the API.
 * Mount it to open it; unmounting clears the form and the last result.
 */
export function WithdrawModal({
  onClose,
  walletAddress,
  available,
}: {
  onClose: () => void
  walletAddress: string
  /** USDC base units, or null while the balance is unknown. */
  available: bigint | null
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

  const problem = checkForm(form, walletAddress, available)
  const canSubmit = problem === null && !withdraw.isPending

  return (
    <Modal
      open
      onClose={onClose}
      title="Withdraw USDC"
      detail={`From your wallet on ${NETWORK.label}`}
    >
      {withdraw.isSuccess ? (
        <Sent
          amount={withdraw.variables.amount}
          to={withdraw.variables.to}
          signature={withdraw.data.signature}
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
          <p className="text-[12.5px] text-fg-3">
            Only send to an address on {NETWORK.label}. The network fee is paid
            in SOL from this wallet.
          </p>
        </form>
      )}
    </Modal>
  )
}

/** The confirmed transfer, with its signature for the explorer. */
function Sent({
  amount,
  to,
  signature,
  onDone,
}: {
  amount: bigint
  to: string
  signature: string
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
        Confirmed by the network.{' '}
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
