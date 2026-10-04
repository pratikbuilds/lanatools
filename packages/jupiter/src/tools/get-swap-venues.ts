import { isRecord, unavailable } from '../client'
import type { ReadContext } from '../client'
import type { SwapVenuesData } from '../types'

export async function getSwapVenues(
  context: ReadContext,
): Promise<SwapVenuesData> {
  const value = await context.get('/swap/v2/program-id-to-label')
  if (!isRecord(value)) throw unavailable()
  const venues: Record<string, string> = {}
  for (const [program, label] of Object.entries(value)) {
    if (typeof label === 'string') venues[program] = label
    else
      context.warnings.push(
        `Jupiter returned an unusable venue label for ${program}.`,
      )
  }
  context.warnings.push(
    'Venue metadata does not guarantee availability for a particular token pair.',
  )
  return { venues }
}
