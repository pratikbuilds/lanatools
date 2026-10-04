import { JupiterReadError, isRecord, unavailable } from '../client'
import type { ReadContext } from '../client'
import type { SearchTokensInput } from '../inputs'
import type { z } from 'zod'
import type { SearchTokensData, VerificationEligibility } from '../types'

export async function searchTokens(
  context: ReadContext,
  input: z.output<typeof SearchTokensInput>,
): Promise<SearchTokensData> {
  const tokens = context.tokens(
    await context.get('/tokens/v2/search', {
      query: input.query ?? input.mints!.join(','),
    }),
  )
  const ids = new Set(tokens.map((token) => token.id))
  if (input.mints && tokens.some((token) => typeof token.id !== 'string'))
    context.warnings.push(
      'Missing mints reflect only identifiable returned token records.',
    )
  if (
    input.mints &&
    (ids.size !== tokens.length ||
      tokens.some(
        (t) => typeof t.id === 'string' && !input.mints!.includes(t.id),
      ))
  )
    context.warnings.push(
      'Jupiter returned duplicate or unrequested token records; records were retained.',
    )
  if (!input.mints)
    context.warnings.push(
      'Name/symbol search defaults to 20 candidates upstream and may not be exhaustive; no pagination is available.',
    )
  const data: SearchTokensData = {
    tokens,
    missingMints: input.mints?.filter((mint) => !ids.has(mint)) ?? [],
    verificationEligibility: null,
    eligibilityError: null,
  }
  if (input.includeVerificationEligibility) {
    try {
      const eligibility = await context.get(
        '/tokens/v2/verify/express/check-eligibility',
        { tokenId: input.mints![0]! },
      )
      if (
        !isRecord(eligibility) ||
        !['tokenExists', 'isVerified', 'canVerify', 'canMetadata'].every(
          (field) => typeof eligibility[field] === 'boolean',
        )
      )
        throw unavailable('Jupiter returned unusable verification eligibility')
      data.verificationEligibility = eligibility as VerificationEligibility
      if (
        tokens.some(
          (token) =>
            typeof token.isVerified === 'boolean' &&
            token.isVerified !== eligibility.isVerified,
        )
      )
        context.warnings.push(
          'Token metadata and eligibility verification status differ; the reads are not an atomic snapshot.',
        )
    } catch (error) {
      if (!(error instanceof JupiterReadError)) throw error
      data.eligibilityError = error.detail
      context.warnings.push(
        'Verification eligibility failed; token search results were retained.',
      )
    }
  }
  return data
}
