import { isAddress } from '@solana/kit'
import { z } from 'zod'
import { buildSolTransfer } from './sol-transfer'
import type { BuilderContext } from './sol-transfer'
import type {
  PreparedTransaction,
  TransactionReview,
} from '@lanatools/contracts'

const solTransferArguments = z.strictObject({
  recipient: z.string().refine(isAddress, 'Enter a valid Solana address'),
  amountLamports: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .pipe(
      z
        .string()
        .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
    ),
})

const idempotencyKey = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)

export const SolanaTransferInput = solTransferArguments.extend({
  idempotencyKey,
})
type SolTransferArguments = z.infer<typeof solTransferArguments>

export type TransactionTool = {
  arguments: z.ZodType
  input: z.ZodType<{ idempotencyKey: string }>
  describe: (input: unknown) => TransactionReview
  build: (
    input: unknown,
    account: string,
    context: BuilderContext,
  ) => Promise<PreparedTransaction>
}

export type TransactionToolRegistry = Readonly<Record<string, TransactionTool>>

/** Keep each builder's argument type inside its validated registry boundary. */
export function defineTransactionTool<
  TShape extends z.ZodRawShape,
>(definition: {
  arguments: z.ZodObject<TShape>
  describe: (input: z.infer<z.ZodObject<TShape>>) => TransactionReview
  build: (
    input: z.infer<z.ZodObject<TShape>>,
    account: string,
    context: BuilderContext,
    review: TransactionReview,
  ) => Promise<PreparedTransaction>
}): TransactionTool {
  return {
    arguments: definition.arguments,
    input: definition.arguments
      .extend({ idempotencyKey })
      .transform((input) => z.looseObject({ idempotencyKey }).parse(input)),
    describe: (input) => definition.describe(definition.arguments.parse(input)),
    build: (input, account, context) => {
      const args = definition.arguments.parse(input)
      return definition.build(args, account, context, definition.describe(args))
    },
  }
}

function describeTransfer(input: SolTransferArguments): TransactionReview {
  const lamports = BigInt(input.amountLamports)
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '')
  const amount = `${lamports / 1_000_000_000n}${fraction ? `.${fraction}` : ''} SOL`
  return {
    title: 'Send SOL',
    description: 'Send SOL from your connected wallet to the recipient below.',
    actionLabel: 'Send SOL',
    fields: [
      { label: 'Amount', value: amount },
      { label: 'Recipient', value: input.recipient },
    ],
  }
}

/** Only registered operations can create public transaction links. */
export const transactionTools = {
  solana_transfer: defineTransactionTool({
    arguments: solTransferArguments,
    describe: describeTransfer,
    build: buildSolTransfer,
  }),
} satisfies TransactionToolRegistry

export function transactionTool(
  name: string,
  registry: TransactionToolRegistry = transactionTools,
): TransactionTool | null {
  return Object.hasOwn(registry, name) ? (registry[name] ?? null) : null
}
