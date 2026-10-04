import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import {
  SearchTokensInput,
  DiscoverTokensInput,
  PricesInput,
  PortfolioInput,
  LendingMarketsInput,
  LendingPositionsInput,
  TriggerOrdersInput,
  QuoteSwapInput,
  SwapVenuesInput,
} from './inputs'
import type { JupiterRequest } from './inputs'
import type { JupiterOutcome } from './types'

export function formatJupiterResult(outcome: JupiterOutcome): CallToolResult {
  if (!outcome.ok)
    return {
      isError: true,
      structuredContent: outcome.error,
      content: [{ type: 'text', text: JSON.stringify(outcome.error) }],
    }
  const { data, warnings } = outcome.result
  let summary: string
  if ('prices' in data)
    summary = `Returned ${Object.keys(data.prices).length} reference prices; ${data.missingMints.length} mints missing.`
  else if ('portfolio' in data)
    summary = `Returned portfolio data; partial: ${data.partial}.`
  else if ('stakedAmount' in data)
    summary = `Returned staked JUP and ${data.unstaking.length} unstaking records.`
  else if ('platforms' in data)
    summary = `Returned ${data.platforms.length} supported platforms.`
  else if ('vaults' in data)
    summary = `Returned ${data.vaults.length} ${data.market} borrow vaults.`
  else if ('positions' in data)
    summary = `Returned ${data.positions.length} ${data.view} records.`
  else if ('earnings' in data)
    summary = `Returned ${data.earnings.length} earnings records.`
  else if ('orders' in data)
    summary = `Returned ${data.orders.length} ${data.view} records on page ${data.pagination.page}; more: ${data.pagination.hasMoreData ?? 'unknown'}.`
  else if ('providerQuote' in data)
    summary = `Quote: ${data.inputAmount.decimal} input to ${data.expectedOutput.decimal} expected output; constraints: ${data.constraints.satisfied ?? 'unknown'}.`
  else if ('venues' in data)
    summary = `Returned ${Object.keys(data.venues).length} venue labels.`
  else if ('view' in data && data.view === 'earn_tokens')
    summary = `Returned ${data.tokens.length} earning tokens in upstream units.`
  else if ('pagination' in data)
    summary = `Returned ${data.tokens.length} ${data.view} token records. Next offset: ${data.pagination.nextOffset ?? 'none'}.`
  else
    summary = `Returned ${data.tokens.length} token records; ${data.missingMints.length} mints missing. Eligibility: ${data.eligibilityError ? 'failed' : data.verificationEligibility ? 'included' : 'not requested'}.`
  if (warnings.length) summary += ` ${warnings.join(' ')}`
  return {
    structuredContent: outcome.result,
    content: [{ type: 'text', text: summary }],
  }
}

export function registerJupiterTools(
  server: McpServer,
  run: (request: JupiterRequest) => CallToolResult | Promise<CallToolResult>,
) {
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  }
  server.registerTool(
    'jupiter_search_tokens',
    {
      title: 'Search Jupiter tokens',
      description:
        'Find token candidates by name/symbol or exact mints. Returns metadata and optional verification eligibility for one mint. Return candidates for explicit selection; verification is not a safety verdict. Requires Jupiter access, no wallet signature.',
      inputSchema: SearchTokensInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_search_tokens', input }),
  )
  server.registerTool(
    'jupiter_discover_tokens',
    {
      title: 'Discover Jupiter tokens',
      description:
        'Read ranked, tagged or recently listed tokens. Tag/recent pagination is local to the upstream list and not a stable snapshot. Requires Jupiter access, no wallet signature.',
      inputSchema: DiscoverTokensInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_discover_tokens', input }),
  )
  server.registerTool(
    'jupiter_get_prices',
    {
      title: 'Read Jupiter prices',
      description:
        'Read reference USD prices for up to 50 unique mints. Missing prices are reported, never treated as zero. Reference prices do not guarantee trade execution prices. Requires Jupiter access, no wallet signature.',
      inputSchema: PricesInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_get_prices', input }),
  )

  server.registerTool(
    'jupiter_get_portfolio',
    {
      title: 'Read Jupiter portfolio',
      description:
        'Read public-wallet holdings, staked JUP or supported platforms. Partial portfolios are not complete valuations. No wallet signature.',
      inputSchema: PortfolioInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_get_portfolio', input }),
  )
  server.registerTool(
    'jupiter_get_lending_markets',
    {
      title: 'Read Jupiter lending markets',
      description:
        'Read Earn tokens or Borrow vaults in main/ethena markets. Rates retain upstream units; no deposits or borrowing.',
      inputSchema: LendingMarketsInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_get_lending_markets', input }),
  )
  server.registerTool(
    'jupiter_get_lending_positions',
    {
      title: 'Read Jupiter lending positions',
      description:
        'Read public-wallet Earn positions/earnings or Borrow positions. Amounts retain upstream units; no wallet signature.',
      inputSchema: LendingPositionsInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_get_lending_positions', input }),
  )
  server.registerTool(
    'jupiter_get_trigger_orders',
    {
      title: 'Read legacy Jupiter orders',
      description:
        'Read public legacy v1 limit or time-based DCA orders. Unmaintained legacy APIs do not cover newer orders. Never creates or cancels orders.',
      inputSchema: TriggerOrdersInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_get_trigger_orders', input }),
  )
  server.registerTool(
    'jupiter_quote_swap',
    {
      title: 'Quote a Jupiter swap',
      description:
        'Estimate an ExactIn swap using decimal token units. Reports slippage/minimum-output constraints. No taker, transaction, signature or submission; quotes may change.',
      inputSchema: QuoteSwapInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_quote_swap', input }),
  )
  server.registerTool(
    'jupiter_get_swap_venues',
    {
      title: 'Read Jupiter swap venues',
      description:
        'Read the full program-ID/venue-label mapping. Metadata does not guarantee availability for a token pair.',
      inputSchema: SwapVenuesInput,
      annotations,
    },
    (input) => run({ tool: 'jupiter_get_swap_venues', input }),
  )
}
