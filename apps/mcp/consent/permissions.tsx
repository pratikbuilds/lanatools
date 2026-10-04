import type { McpScope } from '@lanatools/contracts'

/** The permissions the client actually requested, without implied access. */
export function Permissions({ scopes }: { scopes: readonly McpScope[] }) {
  const payments = scopes.includes('payments:pay')
  return (
    <div className="permission">
      <span className="permission-label">
        {scopes.length > 1 ? 'Permissions requested' : 'Permission requested'}
      </span>
      {scopes.includes('account:read') && (
        <strong>Read account identity</strong>
      )}
      {scopes.includes('jupiter:read') && (
        <>
          <strong>Jupiter access</strong>
          <span>
            Read token information, discovery lists, reference prices,
            public-wallet portfolios and lending data, legacy orders, swap
            quotes and venue information.
          </span>
        </>
      )}
      {scopes.includes('chain:read') && <strong>Read Solana data</strong>}
      {payments ? (
        <>
          <strong>Pay for requests from your wallet</strong>
          <span>
            USDC from your LanaTools payment wallet, only up to the limit you
            set below.
          </span>
        </>
      ) : (
        <span>No wallet or payment access.</span>
      )}
    </div>
  )
}
