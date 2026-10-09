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

const Addresses = z
  .array(Mint)
  .min(1)
  .transform((values) => [...new Set(values)])
const Market = z.enum(['main', 'ethena']).default('main')
export const PortfolioInput = z.discriminatedUnion('view', [
  z.object({
    view: z.literal('positions'),
    wallet: Mint,
    platforms: z
      .array(z.string().trim().min(1))
      .min(1)
      .transform((values) => [...new Set(values)])
      .optional(),
  }),
  z.object({ view: z.literal('staked_jup'), wallet: Mint }),
  z.object({ view: z.literal('platforms') }),
])
export const LendingMarketsInput = z.discriminatedUnion('view', [
  z.object({ view: z.literal('earn_tokens') }),
  z.object({ view: z.literal('borrow_vaults'), market: Market }),
])
export const LendingPositionsInput = z.discriminatedUnion('view', [
  z.object({ view: z.literal('earn_positions'), wallets: Addresses }),
  z.object({
    view: z.literal('earn_earnings'),
    wallet: Mint,
    positionAddresses: Addresses,
  }),
  z.object({
    view: z.literal('borrow_positions'),
    wallets: Addresses,
    market: Market,
  }),
])
const OrderFields = {
  wallet: Mint,
  orderStatus: z.enum(['active', 'history']),
  page: z.number().int().min(1).default(1),
  inputMint: Mint.optional(),
  outputMint: Mint.optional(),
}
export const TriggerOrdersInput = z.discriminatedUnion('view', [
  z.object({ view: z.literal('legacy_price_orders'), ...OrderFields }),
  z.object({
    view: z.literal('legacy_dca_orders'),
    ...OrderFields,
    includeFailedTx: z.boolean().default(false),
  }),
])
const DecimalAmount = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+)?$/, 'Expected a plain decimal amount')
  .refine((value) => /[1-9]/.test(value), 'Amount must be positive')
export const QuoteSwapInput = z
  .object({
    inputMint: Mint,
    outputMint: Mint,
    amount: DecimalAmount,
    maxSlippageBps: z.number().int().min(0).max(10000).optional(),
    minOutputAmount: DecimalAmount.optional(),
  })
  .refine(
    (input) => input.inputMint !== input.outputMint,
    'Input and output mints must differ',
  )
export const BuildSwapInput = QuoteSwapInput.safeExtend({
  wallet: z
    .string()
    .trim()
    .refine((value) => isAddress(value), 'Expected a Solana wallet address'),
}).strict()
export const SwapVenuesInput = z.object({})
export type PortfolioInput = z.input<typeof PortfolioInput>
export type LendingMarketsInput = z.input<typeof LendingMarketsInput>
export type LendingPositionsInput = z.input<typeof LendingPositionsInput>
export type TriggerOrdersInput = z.input<typeof TriggerOrdersInput>
export type QuoteSwapInput = z.input<typeof QuoteSwapInput>
export type BuildSwapInput = z.input<typeof BuildSwapInput>
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
  z.object({ tool: z.literal('jupiter_get_portfolio'), input: PortfolioInput }),
  z.object({
    tool: z.literal('jupiter_get_lending_markets'),
    input: LendingMarketsInput,
  }),
  z.object({
    tool: z.literal('jupiter_get_lending_positions'),
    input: LendingPositionsInput,
  }),
  z.object({
    tool: z.literal('jupiter_get_trigger_orders'),
    input: TriggerOrdersInput,
  }),
  z.object({ tool: z.literal('jupiter_quote_swap'), input: QuoteSwapInput }),
  z.object({ tool: z.literal('jupiter_build_swap'), input: BuildSwapInput }),
  z.object({
    tool: z.literal('jupiter_get_swap_venues'),
    input: SwapVenuesInput,
  }),
])
export type JupiterRequest = z.input<typeof JupiterRequest>
