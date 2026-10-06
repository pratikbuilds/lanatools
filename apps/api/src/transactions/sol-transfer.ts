import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'

export type SolTransfer = {
  walletAddress: string
  recipient: string
  amountLamports: string
  blockhash: string
  lastValidBlockHeight: bigint
}

export function buildSolTransferMessage(expected: SolTransfer) {
  if (
    !/^[1-9]\d{0,19}$/.test(expected.amountLamports) ||
    BigInt(expected.amountLamports) > 18446744073709551615n ||
    expected.lastValidBlockHeight <= 0n
  )
    throw new Error('Invalid SOL transfer amount or lifetime')
  const wallet = address(expected.walletAddress)
  const recipient = address(expected.recipient)
  if (wallet === recipient)
    throw new Error('SOL transfer recipient must differ from the source')
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(wallet, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(expected.blockhash),
          lastValidBlockHeight: expected.lastValidBlockHeight,
        },
        value,
      ),
    (value) =>
      appendTransactionMessageInstruction(
        getTransferSolInstruction({
          source: createNoopSigner(wallet),
          destination: recipient,
          amount: BigInt(expected.amountLamports),
        }),
        value,
      ),
  )
  return new Uint8Array(compileTransaction(message).messageBytes)
}

/** Only one canonical static-account transfer shape is supported. */
export function validateSolTransferMessage(
  bytes: Uint8Array,
  expected: SolTransfer,
) {
  const supported = buildSolTransferMessage(expected)
  if (
    bytes.length !== supported.length ||
    bytes.some((value, index) => value !== supported[index])
  )
    throw new Error('Message does not match the stored SOL transfer')
}
