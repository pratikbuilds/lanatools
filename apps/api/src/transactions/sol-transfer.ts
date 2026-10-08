import {
  address,
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
import type { TransactionRpc } from './submission'

export type BuilderContext = {
  linkId: string
  network: 'mainnet' | 'devnet'
  rpc: TransactionRpc
}

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
