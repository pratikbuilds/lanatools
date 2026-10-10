import type {
  TransactionOperation,
  TransactionContext,
} from '@lanatools/toolkit/transactions'
import type { TransactionRpc } from './submission'

export { publicTransaction } from '@lanatools/toolkit/transactions'

export type BuilderContext = TransactionContext & {
  requestId: string
  rpc: TransactionRpc
  jupiterApiKey?: string | undefined
}

export type TransactionRegistry = Readonly<
  Record<string, TransactionOperation<BuilderContext>>
>

/** Bind server dependencies without redefining the provider's operation. */
export function bindTransaction<TContext extends TransactionContext>(
  operation: TransactionOperation<TContext>,
  configure: (context: BuilderContext) => TContext,
): TransactionOperation<BuilderContext> {
  return {
    ...operation,
    review: (input, context) => operation.review(input, configure(context)),
    build: (input, account, context) =>
      operation.build(input, account, configure(context)),
    relay: (candidate, context) =>
      operation.relay(candidate, configure(context)),
  }
}
