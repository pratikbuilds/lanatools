import { z } from 'zod'
import { isAddress } from '@solana/kit'
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
  /** Programs its transactions call directly; embedded signing allows these. */
  programs: readonly string[]
  operation: TransactionOperation<BuilderContext>
}

export const transactionTools: Readonly<Record<string, TransactionTool>> = {
  solana_transfer: {
    title: 'Send SOL',
    description:
      'Send native SOL from the user wallet to a recipient. amountLamports is in lamports (1 SOL = 1000000000).',
    scope: 'solana:transfer',
    programs: [
      '11111111111111111111111111111111',
      'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
    ],
    operation: solTransfer,
  },
  [jupiterSwapTool.name]: {
    title: jupiterSwapTool.title,
    description: jupiterSwapTool.description,
    scope: 'jupiter:read',
    programs: jupiterSwapTool.programs,
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

/** Every program a transaction tool may call, in a stable order. */
export function transactionPrograms() {
  return [
    ...new Set(
      Object.values(transactionTools).flatMap((tool) => tool.programs),
    ),
  ].sort()
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
  .enum(['link', 'local', 'embedded'])
  .describe(
    "How the transaction is signed. link: returns reviewUrl; the user opens it and signs with their browser wallet. local: returns the unsigned transaction for wallet; sign it with that wallet and pass it to send_transaction. embedded: LanaTools signs with the user's LanaTools wallet and sends it now, without asking the user.",
  )

const wallet = z
  .string()
  .refine(isAddress, 'Expected a Solana wallet address')
  .optional()
  .describe(
    'The address that signs and pays fees. Required for local delivery; omit it for link.',
  )

/** A tool's input: the operation's own arguments plus delivery and a request key. */
export function transactionToolInput(operation: { arguments: z.ZodObject }) {
  return operation.arguments
    .safeExtend({
      delivery,
      wallet,
      idempotencyKey: idempotencyKey.describe(
        'A key you choose for this intent. Reuse it to retry the same request; use a new one for a new transaction.',
      ),
    })
    .refine(
      (input) => (input.delivery === 'local') === (input.wallet !== undefined),
      {
        message: 'Local delivery needs wallet; link and embedded take none.',
        path: ['wallet'],
      },
    )
}
