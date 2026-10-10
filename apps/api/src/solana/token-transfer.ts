import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  address,
  appendTransactionMessageInstructions,
  getBase64Decoder,
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
  GetAccountInfoApi,
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
  getMintDecoder,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  identifyAssociatedTokenInstruction,
  identifyTokenInstruction,
  parseCreateAssociatedTokenIdempotentInstruction,
  parseTransferCheckedInstruction,
} from '@solana-program/token'
import {
  getTransferSolInstruction,
  parseTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
  SystemInstruction,
  identifySystemInstruction,
} from '@solana-program/system'
import { RPC_TIMEOUT_MS } from './network'

export const TOKEN_2022_PROGRAM = address(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
)

/** The transfer cannot be made as asked; the message is for the user. */
export class TransferError extends Error {
  override readonly name = 'TransferError'
}

export type WithdrawalRpc = Rpc<SolanaRpcApi>
/** Enough RPC to inspect mints and token accounts. */
export type AccountRpc = Rpc<GetAccountInfoApi>

function send() {
  return { abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) }
}

/** The associated token account that holds an owner's token. */
export function associatedTokenAccount(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_PROGRAM_ADDRESS,
) {
  return findAssociatedTokenPda({
    owner,
    mint,
    tokenProgram,
  }).then(([account]) => account)
}

/**
 * Where the token goes. A wallet address gets its associated token account,
 * created if needed. An address that already is a token account, as an
 * exchange's deposit address can be, is used as it is: deriving another
 * account from it would strand the funds.
 */
async function destinationFor(
  rpc: AccountRpc,
  to: Address,
  mint: Address,
  program: Address,
) {
  const existing = await fetchEncodedAccount(rpc, to, send())
  if (!existing.exists)
    return {
      account: await associatedTokenAccount(to, mint, program),
      create: true,
    }
  if (existing.programAddress === program) {
    if (decodeToken(existing).data.mint !== mint)
      throw new TransferError(
        'That address is a token account for another token',
      )
    return { account: to, create: false }
  }
  if (
    existing.programAddress === TOKEN_PROGRAM_ADDRESS ||
    existing.programAddress === TOKEN_2022_PROGRAM
  )
    throw new TransferError('That address is a token account, not a wallet')
  return {
    account: await associatedTokenAccount(to, mint, program),
    create: true,
  }
}

/** The program that owns `mint`, and its decimals. */
export async function readTokenMint(rpc: AccountRpc, mint: Address) {
  const mintAccount = await fetchEncodedAccount(rpc, mint, send())
  if (
    !mintAccount.exists ||
    (mintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS &&
      mintAccount.programAddress !== TOKEN_2022_PROGRAM)
  )
    throw new TransferError('That address is not a token mint')
  const { decimals, isInitialized } = getMintDecoder().decode(mintAccount.data)
  if (!isInitialized)
    throw new TransferError('That token mint is not initialized')
  return { program: mintAccount.programAddress, decimals }
}

/**
 * The instructions that move `amount` base units of `mint` from the owner's
 * token account to the recipient's: a checked transfer, after creating the
 * recipient's associated token account at the owner's expense when it does
 * not exist yet. The owner must hold enough, and may not pay itself.
 */
export async function tokenTransferInstructions(
  rpc: AccountRpc,
  {
    owner,
    to,
    amount,
    mint,
    program,
    decimals,
    source: sourceAccount,
  }: {
    owner: Address
    to: Address
    amount: bigint
    mint: Address
    program: Address
    decimals: number
    source?: Address
  },
): Promise<Instruction[]> {
  const source =
    sourceAccount ?? (await associatedTokenAccount(owner, mint, program))
  const [held, destination] = await Promise.all([
    fetchMaybeToken(rpc, source, send()),
    destinationFor(rpc, to, mint, program),
  ])
  if (destination.account === source)
    throw new TransferError('Enter an address other than this wallet')
  if (
    !held.exists ||
    held.programAddress !== program ||
    held.data.owner !== owner ||
    held.data.mint !== mint
  )
    throw new TransferError(
      'That token account does not belong to this wallet and mint',
    )
  if (held.data.state !== 1)
    throw new TransferError('That token account is frozen or unavailable')
  if (held.data.amount < amount)
    throw new TransferError('Not enough tokens in the wallet')
  // shortcut: transfer-hook extra accounts need Kit's resolver once a compatible release is available.
  const transfer = getTransferCheckedInstruction(
    {
      source,
      mint,
      destination: destination.account,
      authority: owner,
      amount,
      decimals,
    },
    { programAddress: program },
  )
  return destination.create
    ? [
        getCreateAssociatedTokenIdempotentInstruction({
          payer: createNoopSigner(owner),
          ata: destination.account,
          owner: to,
          mint,
          tokenProgram: program,
        }),
        transfer,
      ]
    : [transfer]
}

/**
 * Builds an unsigned transfer of `amount` token base units from the owner's
 * token account to the recipient's. The owner pays the network fee. Returns
 * the base64 wire transaction for the owner to sign.
 */
export async function prepareTokenTransfer(
  rpc: WithdrawalRpc,
  {
    owner,
    to,
    amount,
    mint,
    source: sourceAccount,
  }: {
    owner: Address
    to: Address
    amount: bigint
    mint: Address | 'native'
    source?: Address
  },
) {
  if (amount <= 0n || amount > 18_446_744_073_709_551_615n)
    throw new TransferError('Enter a valid amount to withdraw')
  if (owner === to)
    throw new TransferError('Enter an address other than this wallet')
  let instructions: Instruction[]
  if (mint === 'native') {
    const destination = await fetchEncodedAccount(rpc, to, send())
    if (
      destination.exists &&
      destination.programAddress !== SYSTEM_PROGRAM_ADDRESS
    )
      throw new TransferError('Send SOL to a wallet address')
    instructions = [
      getTransferSolInstruction({
        source: createNoopSigner(owner),
        destination: to,
        amount,
      }),
    ]
  } else {
    const token = await readTokenMint(rpc, mint)
    instructions = await tokenTransferInstructions(rpc, {
      owner,
      to,
      amount,
      mint,
      ...token,
      ...(sourceAccount ? { source: sourceAccount } : {}),
    })
  }
  const { value: lifetime } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send(send())
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const transaction = compileTransaction(message)
  if (mint === 'native') {
    const [balance, fee] = await Promise.all([
      rpc.getBalance(owner, { commitment: 'confirmed' }).send(send()),
      rpc
        .getFeeForMessage(
          getBase64Decoder().decode(transaction.messageBytes) as Parameters<
            WithdrawalRpc['getFeeForMessage']
          >[0],
          { commitment: 'confirmed' },
        )
        .send(send()),
    ])
    if (fee.value === null)
      throw new TransferError('Could not estimate the network fee. Try again.')
    if (amount + fee.value > balance.value)
      throw new TransferError(
        'Leave enough SOL in the wallet for the network fee',
      )
  }
  const wire = getBase64EncodedWireTransaction(transaction)
  const simulation = await rpc
    .simulateTransaction(wire, {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send(send())
  if (simulation.value.err)
    throw new TransferError(
      'This transfer could not be simulated. Check the SOL for fees and any token transfer restrictions.',
    )
  return wire
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
 * Reads a signed transaction and accepts it only if it is a token withdrawal
 * of the shape `prepareTokenTransfer` builds, signed by its payer. Anything
 * else is refused, so the server's RPC relays nothing but withdrawals.
 */
export async function readSignedWithdrawal(
  wire: string,
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

  if (!(await isTokenWithdrawal(instructions, payer)))
    throw new TransferError('The signed transaction is not a token withdrawal')

  return {
    transaction,
    payer,
    signature: getBase58Decoder().decode(signature),
    blockhash: toBlockhash(blockhash),
  }
}

/**
 * Whether the instructions are exactly a token transfer authorized by the
 * payer, optionally after creating the recipient's token account at the
 * payer's expense: the shapes `prepareTokenTransfer` builds.
 */
async function isTokenWithdrawal(
  instructions: readonly Instruction[],
  payer: Address,
) {
  try {
    const [first, second] = instructions
    const transfer = second ?? first
    if (!transfer?.data || instructions.length > 2) return false
    if (transfer.programAddress === SYSTEM_PROGRAM_ADDRESS) {
      if (
        instructions.length !== 1 ||
        identifySystemInstruction(transfer.data) !==
          SystemInstruction.TransferSol
      )
        return false
      const parsed = parseTransferSolInstruction(
        transfer as Parameters<typeof parseTransferSolInstruction>[0],
      )
      return (
        parsed.accounts.source.address === payer &&
        parsed.accounts.destination.address !== payer &&
        parsed.data.amount > 0n
      )
    }
    if (
      (transfer.programAddress !== TOKEN_PROGRAM_ADDRESS &&
        transfer.programAddress !== TOKEN_2022_PROGRAM) ||
      identifyTokenInstruction(transfer.data) !==
        TokenInstruction.TransferChecked
    )
      return false
    const { accounts, data } = parseTransferCheckedInstruction(
      transfer as Parameters<typeof parseTransferCheckedInstruction>[0],
    )
    if (
      transfer.accounts?.length !== 4 ||
      accounts.authority.address !== payer ||
      accounts.source.address === accounts.destination.address ||
      data.amount === 0n
    )
      return false
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
      const expected = await associatedTokenAccount(
        create.accounts.owner.address,
        accounts.mint.address,
        transfer.programAddress,
      )
      if (
        first.accounts?.length !== 6 ||
        create.accounts.payer.address !== payer ||
        create.accounts.mint.address !== accounts.mint.address ||
        create.accounts.tokenProgram.address !== transfer.programAddress ||
        create.accounts.ata.address !== expected ||
        accounts.destination.address !== expected
      )
        return false
    }
    return true
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
export async function sendWithdrawal(
  rpc: WithdrawalRpc,
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
    const failure = rejected(error)
    if (failure instanceof TransferError) throw failure
    return { signature, confirmed: false }
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
