import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { SearchTokensInput, DiscoverTokensInput, PricesInput } from './inputs'
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
}
