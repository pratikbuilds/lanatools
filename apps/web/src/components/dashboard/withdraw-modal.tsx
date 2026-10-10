import { useSignTransaction, useWallets } from '@privy-io/react-auth/solana'
import { isAddress } from '@solana/kit'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { WalletToken } from '@lanatools/contracts'
import { useState } from 'react'
import { NETWORK } from '#/lib/solana'
import {
  formatTokenAmount,
  parseTokenAmount,
  withdrawToken,
} from '#/lib/withdrawals'
import type { SignTransaction } from '#/lib/withdrawals'
import { Modal } from './modal'
import { SolanaMark } from './solana-mark'
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

export type Balances = { usdc: bigint; sol: bigint; tokens: WalletToken[] }

/**
 * What is wrong with the form, or null when it can be sent. Nothing can be
 * sent until the balances have loaded: they prove the API reads the network
 * this page names, and the amount is checked against them.
 */
export function checkForm(
  { to, amount }: { to: string; amount: string },
  walletAddress: string,
  balances: Balances | null,
  token: WalletToken | null,
) {
  if (!to || !amount || !balances || !token) return 'incomplete'
  if (!isAddress(to)) return 'Enter a valid Solana address.'
  if (to === walletAddress) return 'Enter an address other than this wallet.'
  const units = parseTokenAmount(amount, token.decimals)
  if (units === null)
    return `Enter an amount in ${token.symbol ?? 'tokens'}, up to ${token.decimals} decimals.`
  if (units > BigInt(token.amount)) return 'That is more than the wallet holds.'
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
 * Withdraws the selected token to another address, in a centred modal. The transfer is
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
  const tokens: WalletToken[] = balances
    ? [
        ...balances.tokens,
        {
          account: 'native',
          mint: 'native',
          program: '11111111111111111111111111111111',
          amount: String(balances.sol),
          decimals: 9,
          name: 'Solana',
          symbol: 'SOL',
          image: null,
        },
      ]
    : []
  const [selected, setSelected] = useState(
    balances?.tokens.find((item) => item.mint === NETWORK.usdcMint)?.account ??
      balances?.tokens[0]?.account ??
      'native',
  )
  const token = tokens.find((item) => item.account === selected) ?? null
  const [form, setForm] = useState({ to: '', amount: '' })
  const withdraw = useMutation({
    mutationFn: (request: {
      to: string
      amount: bigint
      token: WalletToken
    }) => {
      if (!sign) throw new Error('Your wallet is still connecting. Try again.')
      return withdrawToken(
        getAccessToken,
        {
          owner: walletAddress,
          to: request.to,
          amount: String(request.amount),
          mint: request.token.mint,
          ...(request.token.mint === 'native'
            ? {}
            : { source: request.token.account }),
        },
        sign,
      )
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['balances', NETWORK.id] }),
  })

  const problem = checkForm(form, walletAddress, balances, token)
  const fee = feeNote(balances, loadFailed)
  const canSubmit = problem === null && !fee.blocked && !withdraw.isPending
  const available = token ? BigInt(token.amount) : null
  // shortcut: one plain SOL transfer costs 5000 lamports; prepare verifies the actual fee.
  const maximum =
    available === null
      ? null
      : token?.mint === 'native'
        ? available > 5_000n
          ? available - 5_000n
          : 0n
        : available

  return (
    <Modal
      open
      onClose={onClose}
      // Closing midway would lose the withdrawal's state while it still
      // completes, and a reopened form would let the same one be sent twice.
      closable={!withdraw.isPending}
      title="Withdraw"
      detail={`From your wallet on ${NETWORK.label}`}
    >
      {withdraw.isSuccess ? (
        <Sent
          amount={withdraw.variables.amount}
          token={withdraw.variables.token}
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
            const amount =
              token && parseTokenAmount(form.amount, token.decimals)
            if (canSubmit && token && amount !== null)
              withdraw.mutate({ to: form.to, amount, token })
          }}
        >
          <fieldset disabled={withdraw.isPending} className="min-w-0">
            <legend className="d-label mb-2">Token</legend>
            <div className="grid max-h-40 gap-1 overflow-y-auto rounded-lg border border-line p-1">
              {tokens.map((item) => (
                <label
                  key={item.account}
                  className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-md p-2 ${item.account === token?.account ? 'bg-panel-2' : ''}`}
                >
                  <input
                    type="radio"
                    name="token"
                    value={item.account}
                    checked={item.account === token?.account}
                    onChange={() => {
                      setSelected(item.account)
                      setForm({ ...form, amount: '' })
                      withdraw.reset()
                    }}
                  />
                  <TokenImage token={item} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {item.name ??
                        `${item.mint.slice(0, 6)}…${item.mint.slice(-4)}`}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-fg-3">
                      {item.symbol ??
                        `${item.mint.slice(0, 6)}…${item.mint.slice(-4)}`}
                    </span>
                  </span>
                  <span className="max-w-[45%] break-all text-right font-mono text-[12px]">
                    {formatTokenAmount(BigInt(item.amount), item.decimals)}
                  </span>
                </label>
              ))}
            </div>
            {token && token.mint !== 'native' && (
              <p className="mt-2 break-all font-mono text-[10px] text-fg-3">
                Mint: {token.mint}
              </p>
            )}
          </fieldset>
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
              <span className="min-w-0 flex-1 break-all text-right font-mono text-[12px] text-fg-3">
                {available === null
                  ? '—'
                  : `${formatTokenAmount(available, token?.decimals ?? 6)} ${token?.symbol ?? 'tokens'} available`}
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
                disabled={!maximum || withdraw.isPending}
                onClick={() =>
                  maximum &&
                  setForm({
                    ...form,
                    amount: formatTokenAmount(maximum, token?.decimals ?? 6),
                  })
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
  token,
  to,
  signature,
  confirmed,
  onDone,
}: {
  amount: bigint
  token: WalletToken
  to: string
  signature: string
  confirmed: boolean
  onDone: () => void
}) {
  const explorer = `https://explorer.solana.com/tx/${signature}${NETWORK.id === 'mainnet' ? '' : `?cluster=${NETWORK.id}`}`
  return (
    <div className="grid gap-4">
      <div>
        <p className="d-label">{confirmed ? 'Sent' : 'Confirmation pending'}</p>
        <p className="mt-2 font-mono text-[1.6rem] font-semibold tracking-[-0.03em]">
          {formatTokenAmount(amount, token.decimals)}{' '}
          <small className="text-[14px] font-medium tracking-normal text-fg-3">
            {token.symbol ?? 'tokens'}
          </small>
        </p>
        <p className="mt-2 text-[13px] text-fg-2">To</p>
        <code className="block font-mono text-[12.5px] break-all">{to}</code>
      </div>
      <p className="text-[12.5px] text-fg-3">
        {confirmed
          ? 'Confirmed by the network.'
          : 'Confirmation is pending. Check the transaction before sending again.'}{' '}
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

/** Metadata is optional; broken images retain a readable token mark. */
function TokenImage({ token }: { token: WalletToken }) {
  const [failed, setFailed] = useState(false)
  return token.image && !failed ? (
    <img
      src={token.image}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-8 shrink-0 rounded-full object-cover"
    />
  ) : (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full bg-panel-2 text-[12px]"
    >
      {token.mint === 'native' ? (
        <SolanaMark size={18} />
      ) : (
        (token.symbol ?? token.mint).slice(0, 2)
      )}
    </span>
  )
}
