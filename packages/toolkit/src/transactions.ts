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
  arguments: z.ZodType
  supportedNetworks: readonly NetworkId[]
  describe: (input: unknown) => TransactionReview
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
  return {
    arguments: definition.arguments,
    supportedNetworks,
    describe: (input) => definition.describe(definition.arguments.parse(input)),
    async build(input, account, context) {
      const network = checkNetwork(context)
      const args = definition.arguments.parse(input)
      const result = await definition.build(
        args,
        account,
        context,
        definition.describe(args),
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
