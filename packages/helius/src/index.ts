import { defineProvider } from '@lanatools/toolkit'
import { createHeliusClient } from './client'
import type { HeliusOptions } from './client'
import { HeliusError, safeError } from './errors'
import type { HeliusErrorCode } from './errors'
import { jsonSafe } from './format'
import { getAccounts } from './tools/get-accounts'
import { getTransactions } from './tools/get-transactions'
import { getWalletHoldings } from './tools/get-wallet-holdings'
import { getTokenInfo } from './tools/get-token-info'
import { getTransactionHistory } from './tools/get-transaction-history'

export { defineTool } from './tool'
export type { HeliusTool } from './tool'
export type { HeliusOptions } from './client'
export const heliusTools = [
  getAccounts,
  getTransactions,
  getWalletHoldings,
  getTokenInfo,
  getTransactionHistory,
] as const
export type HeliusOutcome =
  | { ok: true; result: Record<string, unknown>; credits: number }
  | {
      ok: false
      error: { code: HeliusErrorCode; message: string; retryable: boolean }
      credits: number
    }
export async function runHeliusTool(
  name: string,
  input: unknown,
  options: HeliusOptions,
): Promise<HeliusOutcome> {
  let client: ReturnType<typeof createHeliusClient> | undefined
  try {
    const tool = heliusTools.find((item) => item.name === name)
    if (!tool) throw new HeliusError('invalid_input')
    const parsed = tool.input.safeParse(input)
    if (!parsed.success) throw new HeliusError('invalid_input')
    client = createHeliusClient(options)
    // Each registry entry owns its schema and handler; validation above is the dispatch boundary.
    const run = tool.run as (
      ctx: typeof client,
      value: unknown,
    ) => Promise<Record<string, unknown>>
    const result = client.redact(
      jsonSafe(await run(client, parsed.data)),
    ) as Record<string, unknown>
    return { ok: true, result, credits: client.credits }
  } catch (error) {
    return { ok: false, error: safeError(error), credits: client?.credits ?? 0 }
  }
}

/** Solana chain reads through a Helius RPC URL, which may hold a key. */
export const helius = defineProvider<HeliusOptions>({
  name: 'helius',
  tools: heliusTools,
  run: runHeliusTool,
})
