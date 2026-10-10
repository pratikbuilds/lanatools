import {
  address,
  isAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getAddMemoInstruction } from '@solana-program/memo'
import type {
  PreparedTransaction,
  TransactionReview,
} from '@lanatools/contracts'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import { z } from 'zod'
import { defineTransactionOperation } from '@lanatools/toolkit/transactions'
import {
  TOKEN_2022_PROGRAM,
  TransferError,
  readTokenMint,
  tokenTransferInstructions,
} from '../solana/token-transfer'
import type { BuilderContext } from './adapter'

/** Programs a token transfer calls directly; the memo names the request. */
export const TOKEN_TRANSFER_PROGRAMS = [
  TOKEN_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
] as const

const MAX_U64 = 18_446_744_073_709_551_615n

const solanaAddress = (message: string) => z.string().refine(isAddress, message)

const tokenTransferArguments = z.strictObject({
  recipient: solanaAddress('Enter a valid Solana address').describe(
    'The wallet that receives the tokens. Its token account is created if needed, at the sender’s expense. An existing token account for this mint is paid directly.',
  ),
  mint: solanaAddress('Enter a valid token mint').describe(
    'The token mint address.',
  ),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?$/, 'Expected a plain decimal amount')
    .refine((value) => /[1-9]/.test(value), 'Amount must be positive')
    .describe(
      'Amount in decimal token units: 1 means one USDC, not one base unit.',
    ),
})

type TokenTransferArguments = z.infer<typeof tokenTransferArguments>

/** USDC is named on the review; other tokens show their mint. */
const USDC_MINTS = new Set<string>(
  Object.values(SOLANA_NETWORKS).map((network) => network.usdcMint),
)

function describeTransfer(input: TokenTransferArguments): TransactionReview {
  const usdc = USDC_MINTS.has(input.mint)
  const unit = usdc
    ? 'USDC'
    : `${input.mint.slice(0, 4)}…${input.mint.slice(-4)}`
  const action = usdc ? 'Send USDC' : 'Send tokens'
  return {
    title: action,
    description:
      'Send tokens from your connected wallet to the recipient below. Network fees are paid in SOL.',
    actionLabel: action,
    fields: [
      { label: 'Amount', value: `${input.amount} ${unit}` },
      { label: 'Token', value: input.mint },
      { label: 'Recipient', value: input.recipient },
    ],
  }
}

/** A decimal amount in the mint's base units; the mint must represent it exactly. */
export function tokenBaseUnits(amount: string, decimals: number): bigint {
  const [whole = '0', fraction = ''] = amount.split('.')
  if (fraction.replace(/0+$/, '').length > decimals)
    throw new TransferError(
      `This token has ${decimals} decimals; the amount has more`,
    )
  const units = BigInt(
    whole + fraction.slice(0, decimals).padEnd(decimals, '0'),
  )
  if (units > MAX_U64) throw new TransferError('Amount is too large')
  return units
}

export const tokenTransfer = defineTransactionOperation({
  arguments: tokenTransferArguments,
  describe: describeTransfer,
  build: buildTokenTransfer,
  submission: {
    schema: z.undefined(),
    send: (wire, _candidate, _execution, context) => context.rpc.send(wire),
  },
})

export async function buildTokenTransfer(
  input: TokenTransferArguments,
  account: string,
  context: BuilderContext,
  review: TransactionReview,
): Promise<PreparedTransaction> {
  const payer = address(account)
  const mint = address(input.mint)
  const token = await readTokenMint(context.rpc.accounts, mint)
  const [instructions, lifetime] = await Promise.all([
    tokenTransferInstructions(context.rpc.accounts, {
      owner: payer,
      to: address(input.recipient),
      amount: tokenBaseUnits(input.amount, token.decimals),
      mint,
      ...token,
    }),
    context.rpc.latestBlockhash(),
  ])
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(payer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
    (message) =>
      appendTransactionMessageInstructions(
        [
          ...instructions,
          getAddMemoInstruction({ memo: `lanatools:${context.requestId}` }),
        ],
        message,
      ),
  )
  return {
    transaction: getBase64EncodedWireTransaction(
      compileTransaction(transactionMessage),
    ),
    account,
    network: context.network,
    review,
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
  }
}
