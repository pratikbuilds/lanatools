import type { JupiterClientOptions } from './client'
import type { JupiterRequest } from './inputs'
import { readJupiter } from './read'
import type { JupiterOutcome } from './types'

export * from './types'
export {
  SearchTokensInput,
  DiscoverTokensInput,
  PricesInput,
  PortfolioInput,
  LendingMarketsInput,
  LendingPositionsInput,
  TriggerOrdersInput,
  QuoteSwapInput,
  SwapVenuesInput,
  JupiterRequest,
} from './inputs'
export type { JupiterClientOptions, JupiterFetch } from './client'

export { jupiter, jupiterTools } from './provider'
export { readJupiter } from './read'

export class JupiterClient {
  constructor(private readonly options: JupiterClientOptions) {}

  read(request: JupiterRequest): Promise<JupiterOutcome> {
    return readJupiter(this.options, request)
  }
}
