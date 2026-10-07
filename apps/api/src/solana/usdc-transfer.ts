import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  fetchEncodedAccount,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
  verifySignature,
} from '@solana/kit'
import type {
  Address,
  Blockhash,
  Instruction,
  Rpc,
  SolanaRpcApi,
  Transaction,
} from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AssociatedTokenInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  decodeToken,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  identifyAssociatedTokenInstruction,
  identifyTokenInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
} from '@solana-program/token'
import { RPC_TIMEOUT_MS } from './network'

/**
 * A USDC transfer the wallet's owner signs in the browser. The server builds
 * it and sends it, so the RPC URL stays on the server; it never signs it,
 * so only the owner can move the funds.
 */

const USDC_DECIMALS = 6
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

/** The transfer cannot be made as asked; the message is for the user. */
export class TransferError extends Error {
  override readonly name = 'TransferError'
}

export type UsdcRpc = Rpc<SolanaRpcApi>

function send() {
  return { abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) }
}

/** The associated token account that holds an owner's USDC. */
export function usdcAccount(owner: Address, mint: Address) {
  return findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  }).then(([account]) => account)
}

/**
 * Where the USDC goes. A wallet address gets its associated token account,
 * created if needed. An address that already is a USDC token account, as an
 * exchange's deposit address can be, is used as it is: deriving another
 * account from it would strand the funds.
 */
async function destinationFor(rpc: UsdcRpc, to: Address, mint: Address) {
  const existing = await fetchEncodedAccount(rpc, to, send())
  if (!existing.exists)
    return { account: await usdcAccount(to, mint), create: true }
  if (existing.programAddress === TOKEN_PROGRAM_ADDRESS) {
    if (decodeToken(existing).data.mint !== mint)
      throw new TransferError(
        'That address is a token account for another token',
      )
    return { account: to, create: false }
  }
  if (existing.programAddress === TOKEN_2022_PROGRAM)
    throw new TransferError('That address is a token account, not a wallet')
  return { account: await usdcAccount(to, mint), create: true }
}

/**
 * Builds an unsigned transfer of `amount` USDC base units from the owner's
 * token account to the recipient's. The owner pays the network fee. Returns
 * the base64 wire transaction for the owner to sign.
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

  const source = await usdcAccount(owner, mint)
  const [held, destination] = await Promise.all([
    fetchMaybeToken(rpc, source, send()),
    destinationFor(rpc, to, mint),
  ])
  if (destination.account === source)
    throw new TransferError('Enter an address other than this wallet')
  if (!held.exists || held.data.amount < amount)
    throw new TransferError('Not enough USDC in the wallet')

  const { value: lifetime } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send(send())
  const transfer = getTransferCheckedInstruction({
    source,
    mint,
    destination: destination.account,
    authority: owner,
    amount,
    decimals: USDC_DECIMALS,
  })
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) =>
      appendTransactionMessageInstructions(
        destination.create
          ? [
              getCreateAssociatedTokenIdempotentInstruction({
                payer: createNoopSigner(owner),
                ata: destination.account,
                owner: to,
                mint,
              }),
              transfer,
            ]
          : [transfer],
        m,
      ),
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

/** A signed withdrawal that has been checked and may be sent. */
export type SignedWithdrawal = {
  transaction: Transaction
  /** The wallet that pays the fee and authorizes the transfer. */
  payer: Address
  signature: string
  blockhash: Blockhash
}

/**
 * Reads a signed transaction and accepts it only if it is a USDC withdrawal
 * of the shape `prepareUsdcTransfer` builds, signed by its payer. Anything
 * else is refused, so the server's RPC relays nothing but withdrawals.
 */
export async function readSignedWithdrawal(
  wire: string,
  mint: Address,
): Promise<SignedWithdrawal> {
  let transaction: Transaction
  let payer: Address
  let blockhash: string
  let instructions: readonly Instruction[]
  try {
    transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(wire),
    )
    const compiled = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    )
    const message = decompileTransactionMessage(compiled)
    payer = message.feePayer.address
    blockhash = compiled.lifetimeToken
    instructions = message.instructions
  } catch {
    throw new TransferError('The signed transaction could not be read')
  }

  const signature = transaction.signatures[payer]
  if (
    !signature ||
    !(await verifySignature(
      await getPublicKeyFromAddress(payer),
      signature,
      transaction.messageBytes,
    ))
  )
    throw new TransferError('The transaction is not signed by the wallet')

  if (!isUsdcWithdrawal(instructions, payer, mint))
    throw new TransferError('The signed transaction is not a USDC withdrawal')

  return {
    transaction,
    payer,
    signature: getBase58Decoder().decode(signature),
    blockhash: toBlockhash(blockhash),
  }
}

/**
 * Whether the instructions are exactly a USDC transfer authorized by the
 * payer, optionally after creating the recipient's token account at the
 * payer's expense: the two shapes `prepareUsdcTransfer` builds.
 */
function isUsdcWithdrawal(
  instructions: readonly Instruction[],
  payer: Address,
  mint: Address,
) {
  try {
    const [first, second] = instructions
    const transfer = second ?? first
    if (!transfer || instructions.length > 2) return false
    if (second && first) {
      if (
        first.programAddress !== ASSOCIATED_TOKEN_PROGRAM_ADDRESS ||
        !first.data ||
        identifyAssociatedTokenInstruction(first.data) !==
          AssociatedTokenInstruction.CreateAssociatedTokenIdempotent
      )
        return false
      const create = parseCreateAssociatedTokenIdempotentInstruction(
        first as Parameters<
          typeof parseCreateAssociatedTokenIdempotentInstruction
        >[0],
      )
      if (
        create.accounts.payer.address !== payer ||
        create.accounts.mint.address !== mint
      )
        return false
    }
    if (
      transfer.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      !transfer.data ||
      identifyTokenInstruction(transfer.data) !==
        TokenInstruction.TransferChecked
    )
      return false
    const { accounts } = parseTransferCheckedInstruction(
      transfer as Parameters<typeof parseTransferCheckedInstruction>[0],
    )
    return (
      accounts.mint.address === mint && accounts.authority.address === payer
    )
  } catch {
    return false
  }
}

/**
 * Sends a checked withdrawal and waits until the cluster confirms it. The
 * transaction's own blockhash bounds the wait: once it expires, a transfer
 * that has not confirmed never will. Once sent, the withdrawal is never
 * reported as failed because of a failed status read: a user who retried
 * would send a second one. It is returned unconfirmed instead, and the
 * balance shows what became of it.
 */
export async function sendUsdcTransfer(
  rpc: UsdcRpc,
  { transaction, signature, blockhash }: SignedWithdrawal,
  { intervalMs = 2_000 } = {},
) {
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

  try {
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
        return { signature, confirmed: true }
      const { value: valid } = await rpc
        .isBlockhashValid(blockhash, { commitment: 'confirmed' })
        .send(send())
      if (!valid)
        throw new TransferError('The transfer expired before it confirmed')
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  } catch (error) {
    if (error instanceof TransferError) throw error
    return { signature, confirmed: false }
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
