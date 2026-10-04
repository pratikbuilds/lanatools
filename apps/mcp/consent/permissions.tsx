import type { ReactNode } from 'react'
import type { McpScope } from '@lanatools/contracts'

/** The permissions the client actually requested, without implied access. */
export function Permissions({ scopes }: { scopes: readonly McpScope[] }) {
  const payments = scopes.includes('payments:pay')
  return (
    <div className="d-card mt-6">
      <p className="d-th d-label flex min-h-9 items-center px-4">
        {scopes.length > 1 ? 'Permissions requested' : 'Permission requested'}
      </p>
      <ul>
        {scopes.includes('account:read') && (
          <Permission title="Read account identity" />
        )}
        {scopes.includes('jupiter:read') && (
          <Permission title="Jupiter access">
            Read token information, discovery lists, reference prices,
            public-wallet portfolios and lending data, legacy orders, swap
            quotes and venue information.
          </Permission>
        )}
        {scopes.includes('chain:read') && (
          <Permission title="Read Solana data" />
        )}
        {payments ? (
          <Permission title="Pay for requests from your wallet" money>
            USDC from your LanaTools payment wallet, only up to the limit you
            set below.
          </Permission>
        ) : (
          <li className="border-t border-line px-4 py-3 text-[13px] text-fg-3">
            No wallet or payment access.
          </li>
        )}
      </ul>
    </div>
  )
}

function Permission({
  title,
  money = false,
  children,
}: {
  title: string
  /** Marks the one permission that can move money. */
  money?: boolean
  children?: ReactNode
}) {
  return (
    <li className="flex gap-3 border-t border-line px-4 py-3">
      <span
        aria-hidden="true"
        className={`mt-[7px] size-[7px] shrink-0 rounded-full ${money ? 'bg-warn' : 'bg-tick'}`}
      />
      <span className="min-w-0">
        <strong className="block font-semibold">{title}</strong>
        {children && (
          <span className="mt-0.5 block text-[13px] text-fg-2">{children}</span>
        )}
      </span>
    </li>
  )
}
