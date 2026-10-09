import { defineTransactionOperation } from '@lanatools/toolkit/transactions'
import type { TransactionContext } from '@lanatools/toolkit/transactions'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import type { JupiterClientOptions } from './client'
import { SwapArguments } from './inputs'
import { JupiterClient } from './jupiter-client'
import {
  address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import { z } from 'zod'

export type JupiterTransactionContext = JupiterClientOptions &
  TransactionContext & {
    blockHeight: () => Promise<bigint>
  }

const argumentsSchema = SwapArguments.safeExtend({
  maxSlippageBps: SwapArguments.shape.maxSlippageBps.unwrap(),
})

function token(mint: string) {
  if (mint === 'So11111111111111111111111111111111111111112') return 'SOL'
  if (mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return 'USDC'
  return mint
}

const swapOperation = defineTransactionOperation({
  supportedNetworks: [SOLANA_NETWORKS.mainnet.name],
  arguments: argumentsSchema,
  describe: (input) => ({
    title: `Swap ${token(input.inputMint)} for ${token(input.outputMint)}`,
    description:
      'Swap from your connected wallet through Jupiter. The quote is fetched when you sign. Network fees are paid in SOL.',
    actionLabel: 'Swap tokens',
    fields: [
      { label: 'You pay', value: `${input.amount} ${token(input.inputMint)}` },
      { label: 'You receive', value: token(input.outputMint) },
      { label: 'Maximum slippage', value: `${input.maxSlippageBps / 100}%` },
      ...(input.minOutputAmount === undefined
        ? []
        : [
            {
              label: 'Minimum receive',
              value: `${input.minOutputAmount} ${token(input.outputMint)}`,
            },
          ]),
    ],
  }),
  async build(input, account, context: JupiterTransactionContext, review) {
    const outcome = await new JupiterClient(context).prepareSwap({
      ...input,
      wallet: account,
    })
    if (!outcome.ok) throw new Error('Jupiter could not prepare this swap')
    const swap = outcome.result.data
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(swap.transaction),
    )
    const message = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    )
    const signers = Object.keys(transaction.signatures)
    if (
      swap.router === 'jupiterz' ||
      swap.fees?.signatureFeePayer !== account ||
      signers.length !== 1 ||
      signers[0] !== account ||
      message.staticAccounts[0] !== account ||
      transaction.signatures[address(account)] !== null ||
      !swap.lastValidBlockHeight ||
      !swap.minimumOutput ||
      swap.constraints.satisfied !== true ||
      !message.lifetimeToken ||
      BigInt(swap.lastValidBlockHeight) <= (await context.blockHeight())
    )
      throw new Error(
        'Jupiter returned an unsupported swap signing or lifetime policy',
      )
    return {
      transaction: swap.transaction,
      account,
      network: context.network,
      blockhash: message.lifetimeToken,
      lastValidBlockHeight: swap.lastValidBlockHeight,
      review: {
        ...review,
        fields: [
          ...review.fields.filter(
            (field) =>
              field.label !== 'You receive' &&
              field.label !== 'Minimum receive',
          ),
          {
            label: 'Estimated receive',
            value: `${swap.expectedOutput.decimal} ${token(input.outputMint)}`,
          },
          {
            label: 'Minimum receive',
            value: `${swap.minimumOutput.decimal} ${token(input.outputMint)}`,
          },
        ],
      },
      execution: { requestId: swap.requestId },
    }
  },
  submission: {
    schema: z.strictObject({ requestId: z.string().trim().min(1) }),
    async send(signedTransaction, candidate, execution, context) {
      const outcome = await new JupiterClient(context).executeSwap({
        signedTransaction,
        requestId: execution.requestId,
        lastValidBlockHeight: candidate.lastValidBlockHeight,
      })
      if (!outcome.ok || !outcome.result.data.signature)
        throw new Error('Jupiter submission outcome is unknown')
      return outcome.result.data.signature
    },
  },
})

/**
 * Programs a wallet-funded Jupiter swap calls directly, read from live
 * `/swap/v2/order` transactions: Compute Budget, System and Token (wrapping
 * SOL), Associated Token and Token-2022 for new or 2022 token accounts, and
 * the Jupiter aggregator. Routed AMMs are called through Jupiter, not here.
 */
export const JUPITER_SWAP_PROGRAMS = [
  'ComputeBudget111111111111111111111111111111',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
] as const

/** A wallet-funded Jupiter swap; network fees are paid in SOL by the signer. */
export const jupiterSwapTool = {
  name: 'jupiter_swap',
  title: 'Swap tokens with Jupiter',
  description:
    'Swap an exact input amount through Jupiter, in decimal token units (1 means one USDC, not one base unit). The quote is fetched when the transaction is prepared for signing. The signing wallet pays network fees in SOL.',
  transaction: swapOperation,
  programs: JUPITER_SWAP_PROGRAMS,
} as const
