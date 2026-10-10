import { z } from 'zod'
import { PreparedTransaction } from '@lanatools/contracts'
import type { TransactionReview } from '@lanatools/contracts'
import {
  SOLANA_NETWORKS,
  parseSolanaNetwork,
} from '@lanatools/contracts/networks'
import type { NetworkId } from '@lanatools/contracts/networks'

export type TransactionContext = { network: NetworkId }

/** Persist unsigned execution metadata only, never signed transaction bytes. */
export type StoredTransaction = PreparedTransaction & { execution?: unknown }

export function publicTransaction(value: unknown): PreparedTransaction {
  const {
    transaction,
    account,
    network,
    review,
    blockhash,
    lastValidBlockHeight,
  } = PreparedTransaction.assert(value)
  return {
    transaction,
    account,
    network,
    review,
    blockhash,
    lastValidBlockHeight,
  }
}

export type TransactionOperation<TContext extends TransactionContext> = {
  arguments: z.ZodObject
  supportedNetworks: readonly NetworkId[]
  describe: (input: unknown) => TransactionReview
  /** The review shown to the signer; may look up names. Falls back to describe. */
  review: (input: unknown, context: TContext) => Promise<TransactionReview>
  build: (
    input: unknown,
    account: string,
    context: TContext,
  ) => Promise<StoredTransaction>
  relay: (
    candidate: unknown,
    context: TContext,
  ) => (signedTransaction: string) => Promise<string>
}

/** An operation owns preparation and relay; each caller owns lifecycle policy. */
export function defineTransactionOperation<
  TShape extends z.ZodRawShape,
  TContext extends TransactionContext,
  TExecution,
>(definition: {
  arguments: z.ZodObject<TShape>
  supportedNetworks?: readonly NetworkId[]
  describe: (input: z.infer<z.ZodObject<TShape>>) => TransactionReview
  /** Optional richer review, such as token names, read when it is needed. */
  review?: (
    input: z.infer<z.ZodObject<TShape>>,
    context: TContext,
  ) => Promise<TransactionReview>
  build: (
    input: z.infer<z.ZodObject<TShape>>,
    account: string,
    context: TContext,
    review: TransactionReview,
  ) => Promise<PreparedTransaction & { execution?: TExecution }>
  submission: {
    schema: z.ZodType<TExecution>
    send: (
      signedTransaction: string,
      candidate: PreparedTransaction,
      execution: TExecution,
      context: TContext,
    ) => Promise<string>
  }
}): TransactionOperation<TContext> {
  const supportedNetworks =
    definition.supportedNetworks ??
    Object.values(SOLANA_NETWORKS).map((network) => network.name)
  function checkNetwork(context: TContext) {
    const network = parseSolanaNetwork(context.network)
    if (!supportedNetworks.includes(network))
      throw new Error('Operation does not support the configured network')
    return network
  }
  async function review(args: z.infer<z.ZodObject<TShape>>, context: TContext) {
    if (!definition.review) return definition.describe(args)
    // A failed lookup leaves the plain review rather than failing the request.
    return definition
      .review(args, context)
      .catch(() => definition.describe(args))
  }
  return {
    arguments: definition.arguments,
    supportedNetworks,
    describe: (input) => definition.describe(definition.arguments.parse(input)),
    review: (input, context) =>
      review(definition.arguments.parse(input), context),
    async build(input, account, context) {
      const network = checkNetwork(context)
      const args = definition.arguments.parse(input)
      const result = await definition.build(
        args,
        account,
        context,
        await review(args, context),
      )
      const candidate = publicTransaction(result)
      if (candidate.network !== network)
        throw new Error('Prepared transaction network mismatch')
      const execution = definition.submission.schema.parse(result.execution)
      return execution === undefined ? candidate : { ...candidate, execution }
    },
    relay(value, context) {
      const network = checkNetwork(context)
      const candidate = publicTransaction(value)
      if (candidate.network !== network)
        throw new Error('Prepared transaction network mismatch')
      const execution = definition.submission.schema.parse(
        z.object({ execution: z.unknown().optional() }).parse(value).execution,
      )
      return (wire) =>
        definition.submission.send(wire, candidate, execution, context)
    },
  }
}
