import type { AuthorizationContext, PrivyClient } from '@privy-io/node'
import {
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from '@solana/kit'
import type { Address, TransactionPartialSigner } from '@solana/kit'

/**
 * A payer signer for Pay Kit backed by a Privy wallet the server may sign for.
 *
 * Pay Kit builds a transfer that the merchant pays fees for and broadcasts, so
 * the wallet only adds its own signature. The signer does not inspect the
 * transaction: amount caps are enforced before Pay Kit asks for a signature.
 */
export function createPrivyPayerSigner({
  privy,
  walletId,
  address,
  authorizationContext,
  onSign,
}: {
  privy: PrivyClient
  walletId: string
  address: Address
  authorizationContext: AuthorizationContext
  onSign?: () => void
}): TransactionPartialSigner {
  return Object.freeze({
    address,
    async signTransactions(transactions, config) {
      return Promise.all(
        transactions.map(async (transaction) => {
          config?.abortSignal?.throwIfAborted()
          onSign?.()
          const { signed_transaction } = await privy
            .wallets()
            .solana()
            .signTransaction(walletId, {
              transaction: getBase64EncodedWireTransaction(transaction),
              authorization_context: authorizationContext,
            })
          const signed = getTransactionDecoder().decode(
            Buffer.from(signed_transaction, 'base64'),
          )
          const signature = signed.signatures[address]
          if (!signature) throw new Error('Privy omitted the wallet signature')
          return Object.freeze({ [address]: signature })
        }),
      )
    },
  })
}
