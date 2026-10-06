import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
} from '@solana/kit'
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit'
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token'
import { RPC_TIMEOUT_MS } from './network'

/**
 * A USDC transfer the wallet's owner signs in the browser. The server builds
 * it and sends it, so the RPC URL stays on the server; it never signs it,
 * so only the owner can move the funds.
 */

const USDC_DECIMALS = 6

/** The transfer cannot be made as asked; the message is for the user. */
export class TransferError extends Error {
  override readonly name = 'TransferError'
}

export type UsdcRpc = Rpc<SolanaRpcApi>

function send() {
  return { abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) }
}

function usdcAccount(owner: Address, mint: Address) {
  return findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  }).then(([account]) => account)
}

/**
 * Builds an unsigned transfer of `amount` USDC base units from the owner's
 * token account to the recipient's, creating the recipient's account if it
 * does not exist. The owner pays the network fee. Returns the base64 wire
 * transaction for the owner to sign.
 */
export async function prepareUsdcTransfer(
  rpc: UsdcRpc,
  {
    owner,
    to,
    amount,
    mint,
  }: { owner: Address; to: Address; amount: bigint; mint: Address },
) {
  if (amount <= 0n) throw new TransferError('Enter an amount to withdraw')
  if (owner === to)
    throw new TransferError('Enter an address other than this wallet')

  const [source, destination] = await Promise.all([
    usdcAccount(owner, mint),
    usdcAccount(to, mint),
  ])
  const held = await fetchMaybeToken(rpc, source, send())
  if (!held.exists || held.data.amount < amount)
    throw new TransferError('Not enough USDC in the wallet')

  const { value: lifetime } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send(send())
  const payer = createNoopSigner(owner)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getCreateAssociatedTokenIdempotentInstruction({
            payer,
            ata: destination,
            owner: to,
            mint,
          }),
          getTransferCheckedInstruction({
            source,
            mint,
            destination,
            authority: owner,
            amount,
            decimals: USDC_DECIMALS,
          }),
        ],
        m,
      ),
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

/**
 * Sends a signed transfer and waits until the cluster confirms it. The
 * transaction's own blockhash bounds the wait: once it expires, a transfer
 * that has not confirmed never will.
 */
export async function sendUsdcTransfer(
  rpc: UsdcRpc,
  signedTransaction: string,
  { intervalMs = 2_000 } = {},
) {
  const { transaction, signature, blockhash } = decode(signedTransaction)
  try {
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(transaction), {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
      })
      .send(send())
  } catch (error) {
    throw rejected(error)
  }

  for (;;) {
    const { value: statuses } = await rpc
      .getSignatureStatuses([toSignature(signature)])
      .send(send())
    const status = statuses[0]
    if (status?.err) throw new TransferError('The transfer failed on chain')
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    )
      return { signature }
    const { value: valid } = await rpc
      .isBlockhashValid(blockhash, { commitment: 'confirmed' })
      .send(send())
    if (!valid)
      throw new TransferError('The transfer expired before it confirmed')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** The transaction with its first signature and blockhash, or a `TransferError`. */
function decode(wire: string) {
  try {
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(wire),
    )
    const { lifetimeToken } = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    )
    const [signature] = Object.values(transaction.signatures)
    if (!signature) throw new Error('unsigned')
    return {
      transaction,
      signature: getBase58Decoder().decode(signature),
      blockhash: toBlockhash(lifetimeToken),
    }
  } catch {
    throw new TransferError('The signed transaction could not be read')
  }
}

/**
 * Why the cluster refused the transaction before sending it, in the user's
 * terms. Other errors keep their cause; they may name the RPC and are not
 * shown to the user.
 */
function rejected(error: unknown) {
  if (
    !isSolanaError(
      error,
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    )
  )
    return error
  // A wallet with no SOL fails as "account not found" before the fee check.
  const needsSol =
    isSolanaError(
      error.cause,
      SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
    ) ||
    isSolanaError(
      error.cause,
      SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
    )
  return new TransferError(
    needsSol
      ? 'The wallet needs SOL to pay the network fee'
      : 'The network rejected the transfer',
  )
}
