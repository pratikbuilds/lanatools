import type { z } from 'zod'
import type { LendingMarketsInput } from '../inputs'
import type { ReadContext } from '../client'
import type { LendingMarketsData } from '../types'

export async function getLendingMarkets(
  context: ReadContext,
  input: z.output<typeof LendingMarketsInput>,
): Promise<LendingMarketsData> {
  context.warnings.push(
    'Rates and amounts retain Jupiter upstream units; rate fields are not normalized to APY.',
  )
  if (input.view === 'earn_tokens')
    return {
      view: input.view,
      tokens: context.records(await context.get('/lend/v1/earn/tokens')),
    }
  return {
    view: input.view,
    market: input.market,
    vaults: context.records(
      await context.get('/lend/v1/borrow/vaults', { market: input.market }),
    ),
  }
}
