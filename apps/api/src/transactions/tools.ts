import { z } from 'zod'
import { jupiterSwapTool } from '@lanatools/jupiter'
import type { ToolScope } from '@lanatools/contracts'
import { solTransfer } from './sol-transfer'
import { bindTransaction } from './adapter'
import type { BuilderContext, TransactionRegistry } from './adapter'
import type { TransactionOperation } from '@lanatools/toolkit/transactions'

export type { TransactionRegistry } from './adapter'

/** One agent-facing transaction tool: its operation and the scope it needs. */
export type TransactionTool = {
  title: string
  description: string
  scope: ToolScope
  operation: TransactionOperation<BuilderContext>
}

export const transactionTools: Readonly<Record<string, TransactionTool>> = {
  solana_transfer: {
    title: 'Send SOL',
    description:
      'Send native SOL from the user wallet to a recipient. amountLamports is in lamports (1 SOL = 1000000000).',
    scope: 'solana:transfer',
    operation: solTransfer,
  },
  [jupiterSwapTool.name]: {
    title: jupiterSwapTool.title,
    description: jupiterSwapTool.description,
    scope: 'jupiter:read',
    operation: bindTransaction(jupiterSwapTool.transaction, (context) => {
      if (!context.jupiterApiKey?.trim())
        throw new Error('Jupiter requires a configured API key')
      return {
        apiKey: context.jupiterApiKey,
        network: context.network,
        blockHeight: () => context.rpc.blockHeight('confirmed'),
      }
    }),
  },
}

/** Existing internal operations available to every delivery path. */
export const transactionOperations: TransactionRegistry = Object.fromEntries(
  Object.entries(transactionTools).map(([name, tool]) => [
    name,
    tool.operation,
  ]),
)

export function transactionOperation(
  name: string,
  registry: TransactionRegistry = transactionOperations,
) {
  return Object.hasOwn(registry, name) ? (registry[name] ?? null) : null
}

/** The scope a transaction tool needs; null only for test registries. */
export function transactionScope(name: string): ToolScope | null {
  return Object.hasOwn(transactionTools, name)
    ? (transactionTools[name]?.scope ?? null)
    : null
}

export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

const delivery = z
  .enum(['link'])
  .describe(
    'How the transaction is signed. link returns a review URL the user opens to sign with their own browser wallet.',
  )

/** A tool's input: the operation's own arguments plus delivery and a request key. */
export function transactionToolInput(operation: { arguments: z.ZodObject }) {
  return operation.arguments.safeExtend({
    delivery,
    idempotencyKey: idempotencyKey.describe(
      'A key you choose for this intent. Reuse it to retry the same request; use a new one for a new transaction.',
    ),
  })
}
