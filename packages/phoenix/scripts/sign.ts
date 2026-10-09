import {
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  signBytes,
} from '@solana/kit'
import type { KeyPairSigner } from '@solana/kit'
import type { PreparedTransaction } from '../src/trade/index'

/**
 * Signs a prepared trade with a local keypair: the transaction, and for
 * Phoenix's referral activation also the login message (UTF-8, ed25519,
 * base58). Partial, because Phoenix adds its own signature to activation.
 */
export async function sign(
  prepared: Pick<PreparedTransaction, 'transaction' | 'submit'>,
  signer: KeyPairSigner,
) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(prepared.transaction),
  )
  const signed = await partiallySignTransaction([signer.keyPair], transaction)
  const loginSignature =
    prepared.submit.via === 'phoenix-referral'
      ? getBase58Decoder().decode(
          await signBytes(
            signer.keyPair.privateKey,
            new TextEncoder().encode(prepared.submit.login.message),
          ),
        )
      : undefined
  return {
    transaction: getBase64EncodedWireTransaction(signed),
    ...(loginSignature ? { loginSignature } : {}),
  }
}
