import { isSignature } from '@solana/kit'
import { z } from 'zod'
import { JupiterReadError, ReadContext, unavailable } from './client'
import type { JupiterClientOptions } from './client'
import { BuildSwapInput } from './inputs'
import { buildSwap } from './tools/build-swap'
import type { BuildSwapData, ExecuteSwapData, JupiterOutcome } from './types'

const ExecuteSwapInput = z.strictObject({
  signedTransaction: z
    .string()
    .min(1)
    .max(1644)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  requestId: z.string().trim().min(1),
  lastValidBlockHeight: z.string().regex(/^\d+$/).optional(),
})
export type ExecuteSwapInput = z.input<typeof ExecuteSwapInput>

const executionResponse = z
  .object({
    status: z.enum(['Success', 'Failed']),
    signature: z.string().refine(isSignature).nullish(),
    code: z.number().int().nullish(),
  })
  .refine((response) => response.status !== 'Success' || !!response.signature)

function failure(error: unknown): JupiterOutcome<never> {
  return {
    ok: false,
    error:
      error instanceof JupiterReadError
        ? error.detail
        : {
            code: 'upstream_unavailable',
            message: 'Jupiter swap request failed',
            retryable: false,
          },
  }
}

function invalidInput(): JupiterOutcome<never> {
  return {
    ok: false,
    error: {
      code: 'invalid_input',
      message: 'Invalid Jupiter swap input',
      retryable: false,
    },
  }
}

/** Prepare a v0 aggregator order; callers must enforce their signing policy. */
export async function prepareSwap(
  options: JupiterClientOptions,
  input: z.input<typeof BuildSwapInput>,
): Promise<JupiterOutcome<BuildSwapData>> {
  const parsed = BuildSwapInput.safeParse(input)
  if (!parsed.success) return invalidInput()
  const context = new ReadContext(options)
  try {
    const data = await buildSwap(context, parsed.data, { excludeRfq: true })
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
    return failure(error)
  }
}

/** One submission attempt. Response loss does not prove the swap failed. */
export async function executeSwap(
  options: JupiterClientOptions,
  input: ExecuteSwapInput,
): Promise<JupiterOutcome<ExecuteSwapData>> {
  const parsed = ExecuteSwapInput.safeParse(input)
  if (!parsed.success) return invalidInput()
  if (!options.apiKey.trim())
    return failure(
      unavailable('Jupiter access is not configured on the server'),
    )

  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    Math.min(
      options.requestTimeoutMs ?? 10_000,
      options.toolTimeoutMs ?? 30_000,
    ),
  )
  try {
    const response = await (options.fetch ?? fetch)(
      'https://api.jup.ag/swap/v2/execute',
      {
        method: 'POST',
        headers: {
          'x-api-key': options.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parsed.data),
        redirect: 'manual',
        signal: controller.signal,
      },
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new JupiterReadError({
        code: response.status === 429 ? 'rate_limited' : 'upstream_unavailable',
        message: `Jupiter execution returned HTTP ${response.status}`,
        retryable: response.status === 429 || response.status >= 500,
      })
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      if (controller.signal.aborted) throw new Error('Execution timed out')
      throw unavailable('Jupiter returned an unusable execution response')
    }
    const result = executionResponse.safeParse(raw)
    if (!result.success)
      throw unavailable('Jupiter returned an unusable execution response')
    return {
      ok: true,
      result: {
        source: 'jupiter',
        network: 'mainnet-beta',
        fetchedAt: new Date().toISOString(),
        data: {
          status: result.data.status,
          signature: result.data.signature ?? null,
          code: result.data.code ?? null,
        },
        warnings: [
          'Jupiter execution status is advisory; verify the signature with Solana RPC before treating the transaction as confirmed or failed.',
        ],
      },
    }
  } catch (error) {
    if (error instanceof JupiterReadError) return failure(error)
    return failure(
      new JupiterReadError({
        code: 'upstream_unavailable',
        message:
          'Jupiter execution response is unavailable; reconcile the transaction signature before retrying',
        retryable: true,
      }),
    )
  } finally {
    clearTimeout(timer)
  }
}
