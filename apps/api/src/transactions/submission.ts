import {
  address,
  createClient,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  signature,
  signatureBytes,
  verifySignature,
} from '@solana/kit'
import type { Blockhash, SolanaRpcApi, Rpc } from '@solana/kit'
import { solanaRpcConnection } from '@solana/kit-plugin-rpc'
import type {
  PreparedTransaction,
  TransactionReceipt,
} from '@lanatools/contracts'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import type { NetworkId } from '@lanatools/contracts/networks'

export type TransactionRpc = {
  /** Account reads for builders that inspect mints and token accounts. */
  accounts: Rpc<SolanaRpcApi>
  genesisHash: () => Promise<string>
  latestBlockhash: () => Promise<{
    blockhash: Blockhash
    lastValidBlockHeight: bigint
  }>
  blockHeight: (commitment?: 'confirmed' | 'finalized') => Promise<bigint>
  send: (transaction: string) => Promise<string>
  status: (signature: string) => Promise<{
    err: unknown
    slot: bigint
    confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null
  } | null>
}

const request = () => ({ abortSignal: AbortSignal.timeout(5_000) })

export function transactionRpc(url: string): TransactionRpc {
  const { rpc } = createClient().use(solanaRpcConnection({ rpcUrl: url }))
  return {
    accounts: rpc,
    genesisHash: () => rpc.getGenesisHash().send(request()),
    latestBlockhash: async () =>
      (
        await rpc
          .getLatestBlockhash({ commitment: 'confirmed' })
          .send(request())
      ).value,
    blockHeight: (commitment = 'confirmed') =>
      rpc.getBlockHeight({ commitment }).send(request()),
    send: (wire) =>
      rpc
        .sendTransaction(wire as Parameters<typeof rpc.sendTransaction>[0], {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
          skipPreflight: false,
        })
        .send(request()),
    status: async (value) =>
      (
        await rpc
          .getSignatureStatuses([signature(value)], {
            searchTransactionHistory: true,
          })
          .send(request())
      ).value[0] ?? null,
  }
}

export async function verifyRpcNetwork(
  rpc: TransactionRpc,
  network: NetworkId,
) {
  if ((await rpc.genesisHash()) !== SOLANA_NETWORKS[network].genesisHash)
    throw new Error('RPC network mismatch')
}

/** The exact persisted message is the authorization boundary, never client claims. */
export async function verifySignedTransaction(
  wire: string,
  candidate: PreparedTransaction,
) {
  const decoder = getTransactionDecoder()
  const encoded = getBase64Encoder().encode(wire)
  if (encoded.length > 1232) throw new Error('Transaction exceeds packet size')
  const signed = decoder.decode(encoded)
  // Round-tripping rejects trailing data and noncanonical base64 encodings.
  if (getBase64EncodedWireTransaction(signed) !== wire)
    throw new Error('Noncanonical transaction')
  const unsigned = decoder.decode(
    getBase64Encoder().encode(candidate.transaction),
  )
  if (
    signed.messageBytes.length !== unsigned.messageBytes.length ||
    !signed.messageBytes.every(
      (byte, index) => byte === unsigned.messageBytes[index],
    )
  )
    throw new Error('Transaction message changed')
  const required = Object.keys(unsigned.signatures)
  const coSigners = candidate.coSigners ?? []
  if (
    required.length !== 1 + coSigners.length ||
    !required.slice(1).every((signer) => coSigners.includes(signer)) ||
    required[0] !== candidate.account ||
    Object.keys(signed.signatures).length !== required.length
  )
    throw new Error('Unsupported required signers')
  for (const signer of required) {
    const bytes = signed.signatures[address(signer)]
    if (coSigners.includes(signer) && bytes === null) continue
    if (
      !bytes ||
      !(await verifySignature(
        await getPublicKeyFromAddress(address(signer)),
        bytes,
        signed.messageBytes,
      ))
    )
      throw new Error('Invalid required signature')
  }
  return getBase58Decoder().decode(
    signed.signatures[address(candidate.account)]!,
  )
}

/** Restore the accepted signature without changing or signing the message. */
export function restoreSignedTransaction(
  candidate: PreparedTransaction,
  acceptedSignature: string,
) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(candidate.transaction),
  )
  return getBase64EncodedWireTransaction({
    ...transaction,
    signatures: {
      ...transaction.signatures,
      [address(candidate.account)]: signatureBytes(
        getBase58Encoder().encode(acceptedSignature),
      ),
    },
  })
}

export type ChainObservation =
  | { status: 'confirmed'; receipt: TransactionReceipt }
  | { status: 'failed' | 'unknown' | 'expired'; receipt: null }

/**
 * How long a send waits by default: past a blockhash's 150 blocks, about 32
 * seconds at mainnet's 0.21 s blocks, so `unknown` is rare rather than the
 * answer to any transaction that takes a few seconds to land.
 */
const OBSERVATION_ATTEMPTS = 48

/** Bounded observation; RPC acceptance (or a timeout) never means confirmation. */
export async function observeSubmission(
  rpc: TransactionRpc,
  transactionSignature: string,
  options: {
    attempts?: number
    intervalMs?: number
    lastValidBlockHeight?: string
  } = {},
): Promise<ChainObservation> {
  const {
    attempts = OBSERVATION_ATTEMPTS,
    intervalMs = 750,
    lastValidBlockHeight,
  } = options
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await rpc.status(transactionSignature)
      if (
        result?.confirmationStatus === 'confirmed' ||
        result?.confirmationStatus === 'finalized'
      ) {
        if (result.err !== null) return { status: 'failed', receipt: null }
        return {
          status: 'confirmed',
          receipt: {
            signature: transactionSignature,
            slot: result.slot.toString(),
            commitment: result.confirmationStatus,
          },
        }
      }
    } catch {
      // A transient read failure must not end the remaining observation window.
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  if (lastValidBlockHeight !== undefined) {
    try {
      if ((await rpc.blockHeight('finalized')) > BigInt(lastValidBlockHeight)) {
        // Re-read history after expiry; a transaction may have landed in its last block.
        const result = await rpc.status(transactionSignature)
        if (result === null) return { status: 'expired', receipt: null }
        if (
          result.confirmationStatus === 'confirmed' ||
          result.confirmationStatus === 'finalized'
        )
          return result.err !== null
            ? { status: 'failed', receipt: null }
            : {
                status: 'confirmed',
                receipt: {
                  signature: transactionSignature,
                  slot: result.slot.toString(),
                  commitment: result.confirmationStatus,
                },
              }
      }
    } catch {
      // Without a successful expiry and history read, the outcome stays unknown.
    }
  }
  return { status: 'unknown', receipt: null }
}

/** Verify the server-prepared login challenge before accepting a transaction. */
export async function verifyTransactionMessage(
  candidate: PreparedTransaction,
  messageSignature?: string,
) {
  if (!candidate.messageToSign) {
    if (messageSignature) throw new Error('Unexpected message signature')
    return
  }
  if (
    !messageSignature ||
    !(await verifySignature(
      await getPublicKeyFromAddress(address(candidate.account)),
      signatureBytes(getBase58Encoder().encode(messageSignature)),
      new TextEncoder().encode(candidate.messageToSign),
    ))
  )
    throw new Error('Invalid login message signature')
}
