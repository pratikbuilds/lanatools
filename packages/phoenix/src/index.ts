import type { z } from 'zod'
import { PhoenixError, createPhoenixClient } from './client'
import type { PhoenixClient, PhoenixErrorCode, PhoenixOpts } from './client'
import type { PhoenixTool } from './tool'
import { getAccount, getHistory } from './tools/account'
import {
  getCandles,
  getMarket,
  getOrderbook,
  listMarkets,
} from './tools/markets'

export { PHOENIX_API_URL } from './client'
export type { PhoenixFetch, PhoenixOpts } from './client'
export type { PhoenixTool } from './tool'

/** Read-only Phoenix perps tools, in the order an agent usually needs them. */
export const phoenixTools = [
  listMarkets,
  getMarket,
  getOrderbook,
  getCandles,
  getAccount,
  getHistory,
] as const

export type PhoenixOutcome =
  | { ok: true; result: unknown }
  | {
      ok: false
      error: { code: PhoenixErrorCode; message: string; retryable: boolean }
    }

function runTool<TSchema extends z.ZodObject>(
  tool: PhoenixTool<TSchema>,
  client: PhoenixClient,
  input: unknown,
) {
  const parsed = tool.input.safeParse(input)
  if (!parsed.success)
    throw new PhoenixError(
      'invalid_input',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  return tool.run(client, parsed.data)
}

/**
 * Validates `input` against the named tool's schema and runs it. Never
 * throws: failures come back as a safe error, without Phoenix's raw body.
 */
export async function runPhoenixTool(
  name: string,
  input: unknown,
  opts: PhoenixOpts = {},
): Promise<PhoenixOutcome> {
  try {
    const tool = phoenixTools.find((item) => item.name === name)
    if (!tool) throw new PhoenixError('invalid_input', `No tool named ${name}`)
    return {
      ok: true,
      result: await runTool(tool, createPhoenixClient(opts), input ?? {}),
    }
  } catch (error) {
    if (error instanceof PhoenixError)
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      }
    console.error(
      JSON.stringify({
        message: 'Phoenix tool failed',
        tool: name,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return {
      ok: false,
      error: {
        code: 'upstream_error',
        message: 'Phoenix read failed',
        retryable: false,
      },
    }
  }
}
