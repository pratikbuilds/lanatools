import type { ReactNode } from 'react'
import { TOOL_SCOPES } from '@lanatools/contracts'
import type { ToolScope } from '@lanatools/contracts'

export const TOOL_FAMILIES: Record<
  ToolScope,
  { title: string; detail: string }
> = {
  'helius:read': {
    title: 'Helius',
    detail: 'Read Solana tokens, wallets and transactions',
  },
  'payments:pay': {
    title: 'Pay',
    detail: 'Pay for APIs in USDC from your LanaTools wallet',
  },
  'jupiter:read': {
    title: 'Jupiter',
    detail:
      'Read token prices, swap quotes and lending data. Swap tokens from your LanaTools wallet without further approval or an amount limit.',
  },
  'phoenix:read': {
    title: 'Phoenix',
    detail: 'Read perps markets, order books and candles',
  },
  'solana:transfer': {
    title: 'Transfers',
    detail:
      'Send SOL and tokens from your LanaTools wallet without further approval or an amount limit.',
  },
}

const PAY: ToolScope = 'payments:pay'
// Pay comes last, so its limit closes the list instead of splitting it.
const ROWS: ToolScope[] = [...TOOL_SCOPES.filter((each) => each !== PAY), PAY]

/**
 * The tool families the user lets this client use, one checkbox each. The
 * catalog and the account ID are always included and cannot be left out.
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
  /** Shown under Pay while it is ticked: where the user sets the limit. */
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
    <>
      {/* One grid for every row, so the names share a column. */}
      <ul className="gap-x-3 sm:grid sm:grid-cols-[auto_auto_1fr]">
        {ROWS.map((scope) => {
          const on = selected.includes(scope)
          return (
            <li
              key={scope}
              className="sm:col-span-3 sm:grid sm:grid-cols-subgrid"
            >
              <label className="-mx-2 grid cursor-pointer grid-cols-[auto_1fr] items-baseline gap-x-3 rounded-[8px] px-2 py-2 hover:bg-panel-2 has-disabled:cursor-wait sm:col-span-3 sm:grid-cols-subgrid">
                <span className="relative row-span-2 grid size-[18px] place-items-center self-start sm:row-span-1 sm:translate-y-[2px]">
                  <input
                    type="checkbox"
                    name={scope}
                    aria-labelledby={`tool-${scope}`}
                    aria-describedby={`tool-${scope}-detail`}
                    checked={on}
                    disabled={disabled}
                    onChange={() => toggle(scope)}
                    className="peer size-full cursor-pointer appearance-none rounded-[5px] border border-line-2 bg-surface checked:border-accent checked:bg-accent disabled:cursor-wait"
                  />
                  <svg
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    className="pointer-events-none absolute size-3.5 fill-none stroke-on-accent stroke-2 opacity-0 peer-checked:opacity-100"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </span>
                <strong
                  id={`tool-${scope}`}
                  className="font-mono text-[13.5px] font-semibold"
                >
                  {TOOL_FAMILIES[scope].title}
                </strong>
                <span
                  id={`tool-${scope}-detail`}
                  className="col-start-2 text-[13px] text-fg-2 sm:col-start-3"
                >
                  {TOOL_FAMILIES[scope].detail}
                </span>
              </label>
              {scope === PAY && on && (
                <div className="pb-1 pl-[30px] sm:col-span-2 sm:col-start-2 sm:pl-0">
                  {payLimit}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <p className="mt-2.5 text-[12.5px] text-fg-3">
        Always included: searching the pay.sh catalog of paid APIs, and seeing
        your account and wallet address.
      </p>
    </>
  )
}
