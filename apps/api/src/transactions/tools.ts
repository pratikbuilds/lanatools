import { z } from 'zod'
import { jupiterBuildSwapTool } from '@lanatools/jupiter'
import { solTransfer } from './sol-transfer'
import { bindTransaction } from './adapter'
import type { TransactionRegistry } from './adapter'

export type { TransactionRegistry } from './adapter'

/** Existing internal operations available to the link signing path. */
export const transactionOperations = {
  solana_transfer: solTransfer,
  [jupiterBuildSwapTool.name]: bindTransaction(
    jupiterBuildSwapTool.transaction,
    (context) => {
      if (!context.jupiterApiKey?.trim())
        throw new Error('Jupiter requires a configured API key')
      return {
        apiKey: context.jupiterApiKey,
        network: context.network,
        blockHeight: () => context.rpc.blockHeight('confirmed'),
      }
    },
  ),
} satisfies TransactionRegistry

export function transactionOperation(
  name: string,
  registry: TransactionRegistry = transactionOperations,
) {
  return Object.hasOwn(registry, name) ? (registry[name] ?? null) : null
}

export const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

/** Generated from the internal schemas; no second copy of transaction arguments. */
export const CreateTransactionLinkInput = z.union(
  Object.entries(transactionOperations).map(([name, operation]) =>
    z.strictObject({
      tool: z.literal(name),
      arguments: operation.arguments.pipe(z.record(z.string(), z.unknown())),
      idempotencyKey,
    }),
  ),
)
