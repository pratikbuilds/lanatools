import {
  CaretDownIcon,
  CheckIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react'
import type { WalletToken } from '@lanatools/contracts'
import { useId, useRef, useState } from 'react'
import { formatTokenAmount } from '#/lib/withdrawals'
import { SolanaMark } from './solana-mark'

export function WithdrawalTokenPicker({
  tokens,
  token,
  disabled,
  onChange,
}: {
  tokens: WalletToken[]
  token: WalletToken | null
  disabled: boolean
  onChange: (token: WalletToken) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const matches = tokens.filter((item) =>
    [item.name, item.symbol, item.mint].some((value) =>
      value?.toLowerCase().includes(search),
    ),
  )

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  return (
    <fieldset
      disabled={disabled}
      className="relative min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (open && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
    >
      <legend className="d-label mb-2">Token</legend>
      <button
        ref={trigger}
        type="button"
        aria-label={`Choose token${token ? `, ${token.symbol ?? token.name ?? token.mint}` : ''}`}
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled || !tokens.length}
        className="flex w-full items-center gap-3 rounded-lg border border-line p-3 text-left hover:border-line-2 disabled:opacity-50"
        onClick={() => {
          setQuery('')
          setOpen(!open)
        }}
      >
        {token ? (
          <TokenIdentity key={token.account} token={token} />
        ) : (
          <span className="flex-1 text-[13px] text-fg-3">Select a token</span>
        )}
        <CaretDownIcon
          size={16}
          className="shrink-0 text-fg-3"
          aria-hidden="true"
        />
      </button>
      <p
        tabIndex={0}
        aria-label={
          token?.mint === 'native'
            ? 'Native SOL, no mint address'
            : token
              ? `Mint: ${token.mint}`
              : 'No token selected'
        }
        className="mt-2 h-5 overflow-x-auto font-mono text-[10px] leading-5 whitespace-nowrap text-fg-3"
      >
        {token?.mint === 'native'
          ? 'Native SOL · No mint address'
          : token
            ? `Mint: ${token.mint}`
            : 'No token selected'}
      </p>
      {open && (
        <div
          id={id}
          className="absolute inset-x-0 top-[calc(100%-1.75rem)] z-10 overflow-hidden rounded-lg border border-line-2 bg-panel shadow-(--d-shadow)"
        >
          <label className="flex items-center gap-2 border-b border-line px-3">
            <MagnifyingGlassIcon
              size={16}
              className="shrink-0 text-fg-3"
              aria-hidden="true"
            />
            <input
              ref={(element) => element?.focus()}
              type="search"
              aria-label="Search tokens"
              placeholder="Search name, symbol or mint"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="d-input h-11 min-w-0 flex-1 border-0 bg-transparent px-0 text-[13px]"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <div
            className="max-h-60 overflow-y-auto overscroll-contain p-1"
            aria-label="Tokens"
          >
            {matches.map((item) => (
              <button
                key={item.account}
                type="button"
                aria-pressed={item.account === token?.account}
                className="flex w-full items-center gap-2 rounded-md p-2 text-left hover:bg-panel-2 focus-visible:bg-panel-2"
                onClick={() => {
                  onChange(item)
                  close()
                }}
              >
                <TokenIdentity token={item} />
                <CheckIcon
                  size={16}
                  aria-hidden="true"
                  className={`shrink-0 text-tick ${item.account === token?.account ? '' : 'invisible'}`}
                />
              </button>
            ))}
            {matches.length === 0 && (
              <p
                role="status"
                className="px-3 py-6 text-center text-[13px] text-fg-3"
              >
                No tokens found. Try a name or mint address.
              </p>
            )}
          </div>
        </div>
      )}
    </fieldset>
  )
}

function TokenIdentity({ token }: { token: WalletToken }) {
  const [failed, setFailed] = useState(false)
  const mint = `${token.mint.slice(0, 6)}…${token.mint.slice(-4)}`
  const amount = formatTokenAmount(BigInt(token.amount), token.decimals)
  return (
    <>
      {token.image && !failed ? (
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
      )}
      <span className="min-w-0 flex-1">
        <span
          className="block truncate text-[13px]"
          title={token.name ?? token.mint}
        >
          {token.name ?? mint}
        </span>
        <span
          className="block truncate font-mono text-[10px] text-fg-3"
          title={token.mint}
        >
          {token.symbol ?? mint}
          {token.symbol && token.mint !== 'native' ? ` · ${mint}` : ''}
        </span>
      </span>
      <span
        className="max-w-[35%] truncate text-right font-mono text-[12px] tabular-nums"
        title={amount}
      >
        {amount}
      </span>
    </>
  )
}
