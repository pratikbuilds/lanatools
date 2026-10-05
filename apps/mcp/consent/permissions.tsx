import type { ReactNode } from 'react'
import { TOOL_SCOPES } from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'

export const TOOL_FAMILIES: Record<
  ToolScope,
  { title: string; detail: string }
> = {
  'helius:read': {
    title: 'Helius',
    detail:
      'Read Solana data: token info, wallet holdings, accounts and transaction history.',
  },
  'payments:pay': {
    title: 'Pay',
    detail:
      'Call paid APIs and pay them in USDC from your LanaTools wallet, up to the limit you set.',
  },
  'jupiter:read': {
    title: 'Jupiter',
    detail:
      'Token search and reference prices, swap quotes and venues, public-wallet portfolios, lending data and legacy orders.',
  },
  'phoenix:read': {
    title: 'Phoenix',
    detail: 'Perps markets, order books, candles and public account history.',
  },
}

/**
 * The tool families the user lets this client use, one switch each. The
 * catalog and the account ID are always included and cannot be switched off.
 */
export function ToolAccess({
  selected,
  onChange,
  disabled = false,
  payLimit,
}: {
  selected: readonly ToolScope[]
  onChange: (selected: ToolScope[]) => void
  disabled?: boolean
  /** Shown under Pay while it is on: where the user sets the limit. */
  payLimit?: ReactNode
}) {
  function toggle(scope: ToolScope) {
    onChange(
      TOOL_SCOPES.filter((each) =>
        each === scope ? !selected.includes(each) : selected.includes(each),
      ),
    )
  }

  return (
    <div className="d-card">
      <p className="d-th flex min-h-9 items-center justify-between gap-3 px-4">
        <span className="d-label">Tools this app can use</span>
        <span className="font-mono text-[11.5px] text-fg-3">
          {selected.length} of {TOOL_SCOPES.length} on
        </span>
      </p>
      <ul>
        {TOOL_SCOPES.map((scope) => {
          const on = selected.includes(scope)
          const money = scope === 'payments:pay'
          return (
            <li key={scope} className="border-t border-line px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="min-w-0 flex-1">
                  <strong
                    id={`tool-${scope}`}
                    className="flex items-center gap-2 font-semibold"
                  >
                    {TOOL_FAMILIES[scope].title}
                    {money && (
                      <span className="rounded-full border border-warn px-1.5 font-mono text-[10.5px] font-medium text-warn">
                        moves money
                      </span>
                    )}
                  </strong>
                  <span
                    id={`tool-${scope}-detail`}
                    className="mt-0.5 block text-[13px] text-fg-2"
                  >
                    {TOOL_FAMILIES[scope].detail}
                  </span>
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-labelledby={`tool-${scope}`}
                  aria-describedby={`tool-${scope}-detail`}
                  disabled={disabled}
                  onClick={() => toggle(scope)}
                  className={`relative mt-0.5 h-[26px] w-11 shrink-0 cursor-pointer rounded-full border border-line-2 bg-panel-2 transition-colors after:absolute after:top-[3px] after:left-[3px] after:size-[18px] after:rounded-full after:bg-fg-3 after:transition-transform disabled:cursor-wait aria-checked:after:translate-x-[18px] aria-checked:after:bg-on-accent motion-reduce:transition-none motion-reduce:after:transition-none ${money ? 'aria-checked:border-warn aria-checked:bg-warn' : 'aria-checked:border-accent aria-checked:bg-accent'}`}
                />
              </div>
              {money && on && payLimit}
            </li>
          )
        })}
        <li className="d-hatch border-t border-line px-4 py-3 text-[13px] text-fg-2">
          <strong className="font-semibold text-fg">Always included:</strong>{' '}
          searching the pay.sh catalog of paid APIs, and seeing which LanaTools
          account and wallet it is connected to.
        </li>
      </ul>
    </div>
  )
}
