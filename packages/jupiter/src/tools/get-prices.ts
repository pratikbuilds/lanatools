import { isRecord, unavailable } from '../client'
import type { ReadContext } from '../client'
import type { PricesInput } from '../inputs'
import type { z } from 'zod'
import type { PriceRecord, PricesData } from '../types'

export async function getPrices(
  context: ReadContext,
  input: z.output<typeof PricesInput>,
): Promise<PricesData> {
  const value = await context.get('/price/v3', { ids: input.mints.join(',') })
  if (!isRecord(value)) throw unavailable()
  const prices: Record<string, PriceRecord> = {}
  for (const [mint, price] of Object.entries(value)) {
    if (isRecord(price)) prices[mint] = price as PriceRecord
    else
      context.warnings.push(
        `Jupiter returned an unusable price entry for ${mint}.`,
      )
  }
  return {
    prices,
    missingMints: input.mints.filter((mint) => !Object.hasOwn(prices, mint)),
  }
}
