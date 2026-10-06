import {
  address,
  createSolanaRpc,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  getTransactionEncoder,
  signature,
  verifySignature,
} from '@solana/kit'
import type { SignatureBytes, Transaction } from '@solana/kit'
import { paymentConfig, RPC_TIMEOUT_MS } from '../solana/network'
import type { SolanaEnv } from '../solana/network'
import { validateSolTransferMessage } from './sol-transfer'
import type { SolTransfer } from './sol-transfer'

function base64Bytes(value: string, maximum: number) {
  if (!value || value.length > Math.ceil(maximum / 3) * 4)
    throw new Error('Invalid transaction encoding or size')
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
  } catch {
    throw new Error('Invalid transaction encoding or size')
  }
  if (bytes.length > maximum || bytesBase64(bytes) !== value)
    throw new Error('Invalid transaction encoding or size')
  return bytes
}

function bytesBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

/** One empty signature followed by the exact persisted message. */
export function unsignedSolWire(messageBase64: string): string {
  const message = base64Bytes(messageBase64, 1232 - 65)
  const wire = new Uint8Array(65 + message.length)
  wire[0] = 1
  wire.set(message, 65)
  return bytesBase64(wire)
}

type SignatureVerifier = (
  walletAddress: string,
  signatureBytes: SignatureBytes,
  message: Transaction['messageBytes'],
) => Promise<boolean>

async function defaultEd25519(
  walletAddress: string,
  signatureBytes: SignatureBytes,
  message: Transaction['messageBytes'],
) {
  return verifySignature(
    await getPublicKeyFromAddress(address(walletAddress)),
    signatureBytes,
    message,
  )
}

/** Verifies the wallet signature over the entire canonical stored action. */
export async function verifySignedSolTransfer(
  signedBase64: string,
  expected: SolTransfer,
  verify: SignatureVerifier = defaultEd25519,
): Promise<{ signedBase64: string; signature: string }> {
  const wire = base64Bytes(signedBase64, 1232)
  let transaction: Transaction
  try {
    transaction = getTransactionDecoder().decode(wire)
  } catch {
    throw new Error('Invalid signed SOL transaction')
  }
  validateSolTransferMessage(new Uint8Array(transaction.messageBytes), expected)
  const signers = Object.keys(transaction.signatures)
  const walletSignature =
    transaction.signatures[address(expected.walletAddress)]
  if (
    signers.length !== 1 ||
    signers[0] !== expected.walletAddress ||
    !walletSignature ||
    walletSignature.length !== 64 ||
    !walletSignature.some((byte) => byte !== 0)
  )
    throw new Error('Expected exactly the source wallet signature')
  const encoded = getTransactionEncoder().encode(transaction)
  if (
    encoded.length !== wire.length ||
    encoded.some((byte, index) => byte !== wire[index])
  )
    throw new Error('Noncanonical signed SOL transaction')
  if (
    !(await verify(
      expected.walletAddress,
      walletSignature,
      transaction.messageBytes,
    ))
  )
    throw new Error('Invalid source wallet signature')
  return {
    signedBase64,
    signature: getBase58Decoder().decode(walletSignature),
  }
}

export type SolExecutionRPC = {
  blockHeight: () => Promise<bigint>
  send: (signedBase64: string) => Promise<string>
  status: (signature: string) => Promise<{
    signedBase64: string
    slot: string
    commitment: 'confirmed' | 'finalized'
    failed: boolean
  } | null>
}

/** Verifies devnet before returning any reader or sender. */
export async function createSolExecutionRpc(
  env: SolanaEnv,
): Promise<SolExecutionRPC> {
  if (env.SOLANA_NETWORK !== 'devnet')
    throw new Error('SOL execution requires devnet')
  const { rpcUrl } = await paymentConfig(env)
  const rpc = createSolanaRpc(rpcUrl)
  const options = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch {
      // Provider exceptions can include the configured URL and its credentials.
      throw new Error('Solana execution RPC request failed')
    }
  }
  return {
    blockHeight: () =>
      bounded(() =>
        rpc.getBlockHeight({ commitment: 'confirmed' }).send(options()),
      ),
    send: (signedBase64) =>
      bounded(() => {
        const transaction = getTransactionDecoder().decode(
          base64Bytes(signedBase64, 1232),
        )
        return rpc
          .sendTransaction(getBase64EncodedWireTransaction(transaction), {
            encoding: 'base64',
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 0n,
          })
          .send(options())
      }),
    status: (transactionSignature) =>
      bounded(async () => {
        const id = signature(transactionSignature)
        const { value } = await rpc
          .getSignatureStatuses([id], { searchTransactionHistory: true })
          .send(options())
        const state = value[0]
        const commitment = state?.confirmationStatus
        if (
          !state ||
          (commitment !== 'confirmed' && commitment !== 'finalized')
        )
          return null
        const transaction = await rpc
          .getTransaction(id, {
            encoding: 'base64',
            commitment,
            maxSupportedTransactionVersion: 0,
          })
          .send(options())
        if (!transaction?.meta) return null
        if (
          state.slot !== transaction.slot ||
          (state.err !== null) !== (transaction.meta.err !== null)
        )
          throw new Error('Inconsistent transaction evidence')
        const signedBase64 = transaction.transaction[0]
        const chainWire = base64Bytes(signedBase64, 1232)
        const decoded = getTransactionDecoder().decode(chainWire)
        const canonicalMessage = getCompiledTransactionMessageEncoder().encode(
          getCompiledTransactionMessageDecoder().decode(decoded.messageBytes),
        )
        if (
          getBase64EncodedWireTransaction(decoded) !== signedBase64 ||
          canonicalMessage.length !== decoded.messageBytes.length ||
          canonicalMessage.some(
            (byte, index) => byte !== decoded.messageBytes[index],
          ) ||
          !Object.values(decoded.signatures).some(
            (signerSignature) =>
              signerSignature &&
              getBase58Decoder().decode(signerSignature) ===
                transactionSignature,
          )
        )
          throw new Error('Invalid transaction evidence')
        return {
          signedBase64,
          slot: String(transaction.slot),
          commitment,
          failed: transaction.meta.err !== null,
        }
      }),
  }
}
