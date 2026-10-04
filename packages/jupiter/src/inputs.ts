import { isAddress } from '@solana/kit'
import { z } from 'zod'

const Mint = z
  .string()
  .trim()
  .refine(
    (value): boolean => isAddress(value),
    'Expected a Solana mint address',
  )
const Mints = (maximum: number) =>
  z
    .array(Mint)
    .min(1)
    .transform((mints) => [...new Set(mints)])
    .refine((mints) => mints.length <= maximum, `Use at most ${maximum} mints`)

export const SearchTokensInput = z
  .object({
    query: z.string().trim().min(1).optional(),
    mints: Mints(100).optional(),
    includeVerificationEligibility: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if ((input.query !== undefined) === (input.mints !== undefined))
      ctx.addIssue({ code: 'custom', message: 'Provide either query or mints' })
    if (input.includeVerificationEligibility && input.mints?.length !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'Eligibility requires exactly one unique mint in mints',
      })
  })

const Limit = z.number().int().min(1).max(100).default(20)
const Offset = z.number().int().nonnegative().default(0)
export const DiscoverTokensInput = z.discriminatedUnion('view', [
  z.object({
    view: z.literal('ranked'),
    category: z.enum(['toporganicscore', 'toptraded', 'toptrending']),
    interval: z.enum(['5m', '1h', '6h', '24h']),
    limit: Limit,
  }),
  z.object({
    view: z.literal('tag'),
    tag: z.enum(['lst', 'verified', 'stocks']),
    limit: Limit,
    offset: Offset,
  }),
  z.object({ view: z.literal('recent'), limit: Limit, offset: Offset }),
])

export const PricesInput = z.object({ mints: Mints(50) })

export type SearchTokensInput = z.input<typeof SearchTokensInput>
export type DiscoverTokensInput = z.input<typeof DiscoverTokensInput>
export type PricesInput = z.input<typeof PricesInput>

export const JupiterRequest = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('jupiter_search_tokens'),
    input: SearchTokensInput,
  }),
  z.object({
    tool: z.literal('jupiter_discover_tokens'),
    input: DiscoverTokensInput,
  }),
  z.object({ tool: z.literal('jupiter_get_prices'), input: PricesInput }),
])
export type JupiterRequest = z.input<typeof JupiterRequest>
