import { APIError } from '@privy-io/node'
import type { PrivyClient } from '@privy-io/node'
import {
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import type {
  Address,
  KeyPairSigner,
  Transaction,
  TransactionPartialSigner,
} from '@solana/kit'

/** Privy refused to sign because the signer's policy denied the transaction. */
export class PolicyDeniedError extends Error {
  override readonly name = 'PolicyDeniedError'
}

/**
 * A Kit signer for a Privy wallet, authorized by the LanaTools server key.
 *
 * This replaces `@solana/keychain-privy`, whose HTTP helper passes
 * `redirect: 'error'` to fetch, which Cloudflare Workers rejects. Privy
 * evaluates the signer's override policy on every call, so this signer can
 * only sign what that policy allows.
 */
export function privyPaymentSigner({
  privy,
  walletId,
  walletAddress,
  authorizationKey,
  onSigned,
}: {
  privy: PrivyClient
  walletId: string
  walletAddress: Address
  authorizationKey: string
  /**
   * Awaited before a signature is returned, so the signed transaction cannot
   * leave the Worker unless this records it. Throwing withholds it.
   */
  onSigned: (payerSignature: string, blockhash: string) => Promise<void>
}): TransactionPartialSigner {
  const decoder = getTransactionDecoder()
  const base64 = getBase64Encoder()
  const base58 = getBase58Decoder()
  const messages = getCompiledTransactionMessageDecoder()
  return {
    address: walletAddress,
    signTransactions: (transactions: readonly Transaction[]) =>
      Promise.all(
        transactions.map(async (transaction) => {
          let signed: string
          try {
            signed = (
              await privy
                .wallets()
                .solana()
                .signTransaction(walletId, {
                  transaction: getBase64EncodedWireTransaction(transaction),
                  authorization_context: {
                    authorization_private_keys: [authorizationKey],
                  },
                })
            ).signed_transaction
          } catch (error) {
            if (isPolicyDenial(error))
              throw new PolicyDeniedError('Privy policy denied the payment', {
                cause: error,
              })
            throw error
          }
          const signature = decoder.decode(base64.encode(signed)).signatures[
            walletAddress
          ]
          if (!signature)
            throw new Error(
              'Privy returned a transaction without our signature',
            )
          await onSigned(
            base58.decode(signature),
            messages.decode(transaction.messageBytes).lifetimeToken,
          )
          return { [walletAddress]: signature }
        }),
      ),
  }
}

/**
 * Pay Kit types its signer as `KeyPairSigner`, although its x402 and MPP
 * payment paths only call the Kit signing methods. A Privy wallet has no
 * local key pair, so this is the single place that crosses that gap. Pay Kit
 * itself is not modified.
 */
export function asPayKitSigner(signer: TransactionPartialSigner) {
  return signer as unknown as KeyPairSigner
}

export function isPolicyDenial(error: unknown): boolean {
  return (
    error instanceof APIError &&
    [400, 403].includes(error.status ?? 0) &&
    hasPolicyCode(error.error)
  )
}

function hasPolicyCode(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  if ('code' in body && body.code === 'policy_violation') return true
  return 'error' in body && hasPolicyCode(body.error)
}
