import type { z } from 'zod'
import type { QuoteSwapInput } from '../inputs'
import type { ReadContext } from '../client'
import { swapOrder } from '../swap'

export async function quoteSwap(
  context: ReadContext,
  input: z.output<typeof QuoteSwapInput>,
) {
  return (await swapOrder(context, input)).quote
}
