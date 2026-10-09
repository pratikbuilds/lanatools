import {
  address,
  isAddress,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { getAddMemoInstruction } from '@solana-program/memo'
import type {
  PreparedTransaction,
  TransactionReview,
} from '@lanatools/contracts'
import { z } from 'zod'
import { defineTransactionOperation } from '@lanatools/toolkit/transactions'
import type { BuilderContext } from './adapter'

const solTransferArguments = z.strictObject({
  recipient: z.string().refine(isAddress, 'Enter a valid Solana address'),
  amountLamports: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .pipe(
      z
        .string()
        .refine((value) => BigInt(value) <= 18_446_744_073_709_551_615n),
    ),
})

type SolTransferArguments = z.infer<typeof solTransferArguments>

function describeTransfer(input: SolTransferArguments): TransactionReview {
  const lamports = BigInt(input.amountLamports)
  const fraction = (lamports % 1_000_000_000n)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '')
  const amount = `${lamports / 1_000_000_000n}${fraction ? `.${fraction}` : ''} SOL`
  return {
    title: 'Send SOL',
    description: 'Send SOL from your connected wallet to the recipient below.',
    actionLabel: 'Send SOL',
    fields: [
      { label: 'Amount', value: amount },
      { label: 'Recipient', value: input.recipient },
    ],
  }
}

export const solTransfer = defineTransactionOperation({
  arguments: solTransferArguments,
  describe: describeTransfer,
  build: buildSolTransfer,
  submission: {
    schema: z.undefined(),
    send: (wire, _candidate, _execution, context) => context.rpc.send(wire),
  },
})

export async function buildSolTransfer(
  input: { recipient: string; amountLamports: string },
  account: string,
  context: BuilderContext,
  review: TransactionReview,
): Promise<PreparedTransaction> {
  const payer = address(account)
  const lifetime = await context.rpc.latestBlockhash()
  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayer(payer, message),
    (message) => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
    (message) =>
      appendTransactionMessageInstructions(
        [
          getTransferSolInstruction({
            source: createNoopSigner(payer),
            destination: address(input.recipient),
            amount: BigInt(input.amountLamports),
          }),
          getAddMemoInstruction({ memo: `lanatools:${context.linkId}` }),
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
