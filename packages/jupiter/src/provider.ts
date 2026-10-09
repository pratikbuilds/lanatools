import { defineProvider } from '@lanatools/toolkit'
import { jupiterBuildSwapTool } from './transaction'
import type { ToolInfo } from '@lanatools/toolkit'
import type { JupiterClientOptions } from './client'
import { readJupiter } from './read'
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
import type { JupiterData, JupiterResult } from './types'

/** Jupiter reads and unsigned transaction preparation. */
export const jupiterTools: readonly ToolInfo[] = [
  {
    name: 'jupiter_search_tokens',
    title: 'Search Jupiter tokens',
    description:
      'Find token candidates by name/symbol or exact mints. Returns metadata and optional verification eligibility for one mint. Return candidates for explicit selection; verification is not a safety verdict. Requires Jupiter access, no wallet signature.',
    input: SearchTokensInput,
  },
  {
    name: 'jupiter_discover_tokens',
    title: 'Discover Jupiter tokens',
    description:
      'Read ranked, tagged or recently listed tokens. Tag/recent pagination is local to the upstream list and not a stable snapshot. Requires Jupiter access, no wallet signature.',
    input: DiscoverTokensInput,
  },
  {
    name: 'jupiter_get_prices',
    title: 'Read Jupiter prices',
    description:
      'Read reference USD prices for up to 50 unique mints. Missing prices are reported, never treated as zero. Reference prices do not guarantee trade execution prices. Requires Jupiter access, no wallet signature.',
    input: PricesInput,
  },
  {
    name: 'jupiter_get_portfolio',
    title: 'Read Jupiter portfolio',
    description:
      'Read public-wallet holdings, staked JUP or supported platforms. Partial portfolios are not complete valuations. No wallet signature.',
    input: PortfolioInput,
  },
  {
    name: 'jupiter_get_lending_markets',
    title: 'Read Jupiter lending markets',
    description:
      'Read Earn tokens or Borrow vaults in main/ethena markets. Rates retain upstream units; no deposits or borrowing.',
    input: LendingMarketsInput,
  },
  {
    name: 'jupiter_get_lending_positions',
    title: 'Read Jupiter lending positions',
    description:
      'Read public-wallet Earn positions/earnings or Borrow positions. Amounts retain upstream units; no wallet signature.',
    input: LendingPositionsInput,
  },
  {
    name: 'jupiter_get_trigger_orders',
    title: 'Read legacy Jupiter orders',
    description:
      'Read public legacy v1 limit or time-based DCA orders. Unmaintained legacy APIs do not cover newer orders. Never creates or cancels orders.',
    input: TriggerOrdersInput,
  },
  {
    name: 'jupiter_quote_swap',
    title: 'Quote a Jupiter swap',
    description:
      'Estimate an ExactIn swap using decimal token units. Reports slippage/minimum-output constraints. No taker, transaction, signature or submission; quotes may change.',
    input: QuoteSwapInput,
  },
  jupiterBuildSwapTool,
  {
    name: 'jupiter_get_swap_venues',
    title: 'Read Jupiter swap venues',
    description:
      'Read the full program-ID/venue-label mapping. Metadata does not guarantee availability for a token pair.',
    input: SwapVenuesInput,
  },
]

/** One line an agent can read before the JSON result. */
function summarize(result: JupiterResult<JupiterData>) {
  const { data, warnings } = result
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
  else if ('transaction' in data)
    summary = `Prepared unsigned swap for ${data.wallet}: ${data.inputAmount.decimal} input to ${data.expectedOutput.decimal} expected output. No signing or submission.`
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
  return summary
}

/** Jupiter reads and unsigned swap preparation. */
export const jupiter = defineProvider<JupiterClientOptions>({
  name: 'jupiter',
  tools: jupiterTools,
  async run(name, input, options) {
    const outcome = await readJupiter(options, { tool: name, input })
    if (!outcome.ok) return { ...outcome, credits: 0 }
    return {
      ok: true,
      result: outcome.result,
      summary: summarize(outcome.result),
      credits: 0,
    }
  },
})
