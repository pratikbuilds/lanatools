import { JupiterReadError, ReadContext } from './client'
import type { JupiterClientOptions } from './client'
import { JupiterRequest } from './inputs'
import { searchTokens } from './tools/search-tokens'
import { discoverTokens } from './tools/discover-tokens'
import { getPrices } from './tools/get-prices'
import type { JupiterData, JupiterOutcome } from './types'

export * from './types'
export {
  SearchTokensInput,
  DiscoverTokensInput,
  PricesInput,
  JupiterRequest,
} from './inputs'
export type { JupiterClientOptions, JupiterFetch } from './client'

export class JupiterClient {
  constructor(private readonly options: JupiterClientOptions) {}

  async read(request: JupiterRequest): Promise<JupiterOutcome> {
    const parsed = JupiterRequest.safeParse(request)
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: 'invalid_input',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
          retryable: false,
        },
      }
    const context = new ReadContext(this.options)
    try {
      const { tool, input } = parsed.data
      let data: JupiterData
      switch (tool) {
        case 'jupiter_search_tokens':
          data = await searchTokens(context, input)
          break
        case 'jupiter_discover_tokens':
          data = await discoverTokens(context, input)
          break
        case 'jupiter_get_prices':
          data = await getPrices(context, input)
          break
      }
      return {
        ok: true,
        result: {
          source: 'jupiter',
          network: 'mainnet-beta',
          fetchedAt: new Date().toISOString(),
          data,
          warnings: context.warnings,
        },
      }
    } catch (error) {
      if (error instanceof JupiterReadError)
        return { ok: false, error: error.detail }
      return {
        ok: false,
        error: {
          code: 'upstream_unavailable',
          message: 'Jupiter read failed',
          retryable: false,
        },
      }
    }
  }
}
