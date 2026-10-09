import type { z } from 'zod'
import type { QuoteSwapInput } from './inputs'
import { JupiterReadError, isRecord, unavailable } from './client'
import type { ReadContext } from './client'
import type { ProviderRecord, QuoteSwapData, TokenAmount } from './types'

function invalid(message: string): never {
  throw new JupiterReadError({
    code: 'invalid_input',
    message,
    retryable: false,
  })
}
function baseUnits(value: string, decimals: number): string {
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals)
    invalid(`Amount exceeds token precision of ${decimals} decimals`)
  const atomic = BigInt(whole! + fraction.padEnd(decimals, '0'))
  if (atomic > 18446744073709551615n)
    invalid('Amount exceeds the token base-unit range')
  return atomic.toString()
}
function amount(base: string, decimals: number): TokenAmount {
  const normalized = BigInt(base)
    .toString()
    .padStart(decimals + 1, '0')
  const fraction = decimals
    ? normalized.slice(-decimals).replace(/0+$/, '')
    : ''
  return {
    baseUnits: BigInt(base).toString(),
    decimals,
    decimal: decimals
      ? normalized.slice(0, -decimals) + (fraction ? '.' + fraction : '')
      : normalized,
  }
}
function integer(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value)
}
/** Strip executable payloads even if upstream adds nested transaction fields. */
function safeQuote(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeQuote)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'transaction',
            'signedTransaction',
            'serializedTransaction',
          ].includes(key),
      )
      .map(([key, entry]) => [key, safeQuote(entry)]),
  )
}
export async function swapOrder(
  context: ReadContext,
  input: z.output<typeof QuoteSwapInput>,
  taker?: string,
  policy?: { excludeRfq: true },
): Promise<{ quote: QuoteSwapData; raw: ProviderRecord }> {
  const tokens = context.tokens(
    await context.get('/tokens/v2/search', {
      query: [input.inputMint, input.outputMint].join(','),
    }),
  )
  const decimals = (mint: string) => {
    const value = tokens.find((token) => token.id === mint)?.decimals
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 255
    )
      throw unavailable(
        'Jupiter token decimals are unavailable; amount conversion cannot be performed',
      )
    return value
  }
  const inputDecimals = decimals(input.inputMint),
    outputDecimals = decimals(input.outputMint)
  const requested = baseUnits(input.amount, inputDecimals)
  const requestedMinimum =
    input.minOutputAmount === undefined
      ? null
      : baseUnits(input.minOutputAmount, outputDecimals)
  const parameters: Record<string, string> = {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    amount: requested,
    swapMode: 'ExactIn',
  }
  if (input.maxSlippageBps !== undefined)
    parameters.slippageBps = String(input.maxSlippageBps)
  if (taker !== undefined) {
    parameters.taker = taker
    parameters.maxSupportedTransactionVersion = '0'
  }
  if (policy?.excludeRfq) parameters.excludeRouters = 'jupiterz'
  const raw = await context.get('/swap/v2/order', parameters)
  if (!isRecord(raw)) throw unavailable()
  if (
    raw.error ||
    raw.errorCode ||
    (integer(raw.outAmount) && BigInt(raw.outAmount) === 0n)
  )
    throw new JupiterReadError({
      code: 'no_route',
      message: 'Jupiter did not return a usable quote route',
      retryable: false,
    })
  if (
    !integer(raw.outAmount) ||
    !integer(raw.inAmount) ||
    BigInt(raw.inAmount) !== BigInt(requested) ||
    raw.inputMint !== input.inputMint ||
    raw.outputMint !== input.outputMint ||
    (raw.swapMode !== undefined && raw.swapMode !== 'ExactIn')
  )
    throw unavailable(
      'Jupiter returned unusable quote amounts or token identities',
    )
  const providerQuote = safeQuote(raw) as ProviderRecord
  const minimumOutput = integer(raw.otherAmountThreshold)
    ? amount(raw.otherAmountThreshold, outputDecimals)
    : null
  const slippageBps =
    typeof raw.slippageBps === 'number' &&
    Number.isFinite(raw.slippageBps) &&
    raw.slippageBps >= 0
      ? raw.slippageBps
      : null
  const checks: (boolean | null)[] = []
  if (input.maxSlippageBps !== undefined)
    checks.push(
      slippageBps === null ? null : slippageBps <= input.maxSlippageBps,
    )
  if (requestedMinimum !== null)
    checks.push(
      minimumOutput === null
        ? null
        : BigInt(minimumOutput.baseUnits) >= BigInt(requestedMinimum),
    )
  const satisfied = checks.includes(false)
    ? false
    : checks.length && !checks.includes(null)
      ? true
      : null
  const impact: ProviderRecord = {}
  if (typeof raw.priceImpact === 'number')
    impact.percentagePoints = raw.priceImpact
  if (typeof raw.priceImpactPct === 'string')
    impact.decimalRatio = raw.priceImpactPct
  const fees: ProviderRecord = {}
  for (const field of [
    'feeMint',
    'feeBps',
    'platformFee',
    'signatureFeeLamports',
    'signatureFeePayer',
    'prioritizationFeeLamports',
    'prioritizationFeePayer',
    'rentFeeLamports',
    'rentFeePayer',
  ])
    if (raw[field] !== undefined) fees[field] = providerQuote[field]
  if (taker === undefined)
    context.warnings.push(
      'This is a quote only; no transaction was requested or returned. Prices and routes may change before execution.',
    )
  if (satisfied === false)
    context.warnings.push(
      'The quote does not satisfy the requested constraints.',
    )
  if (checks.includes(null))
    context.warnings.push(
      'Jupiter omitted fields needed to confirm the requested constraints.',
    )
  const quote: QuoteSwapData = {
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    inputAmount: amount(requested, inputDecimals),
    expectedOutput: amount(raw.outAmount, outputDecimals),
    minimumOutput,
    slippageBps,
    priceImpact: Object.keys(impact).length ? impact : null,
    fees: Object.keys(fees).length ? fees : null,
    routePlan: Array.isArray(providerQuote.routePlan)
      ? context.records(providerQuote.routePlan)
      : [],
    router: typeof raw.router === 'string' ? raw.router : null,
    constraints: {
      maxSlippageBps: input.maxSlippageBps ?? null,
      minOutputAmount: input.minOutputAmount ?? null,
      satisfied,
    },
    providerQuote,
  }
  return { quote, raw }
}
