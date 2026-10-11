import { defineTransactionOperation } from '@lanatools/toolkit/transactions'
import type { TransactionContext } from '@lanatools/toolkit/transactions'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import type { SwapTrade, TransactionReview } from '@lanatools/contracts'
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

const KNOWN: Readonly<Record<string, string>> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
}

/** What the review shows for a token: its symbol and, when known, its logo. */
type TokenLabel = { symbol: string; icon?: string }
type Labels = (mint: string) => TokenLabel

/** Without Jupiter: known symbols, else a shortened mint. */
const fallbackLabel: Labels = (mint) => ({
  symbol: KNOWN[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
})

/** Symbols and logos from Jupiter's token list; only https logos are kept. */
async function tokenLabels(
  context: JupiterTransactionContext,
  mints: string[],
): Promise<Labels> {
  const outcome = await new JupiterClient(context).read({
    tool: 'jupiter_search_tokens',
    input: { mints },
  })
  if (!outcome.ok || !('tokens' in outcome.result.data)) return fallbackLabel
  const tokens: readonly unknown[] = outcome.result.data.tokens
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined
  return (mint) => {
    const token = tokens.find(
      (each): each is Record<string, unknown> =>
        typeof each === 'object' &&
        each !== null &&
        'id' in each &&
        each.id === mint,
    )
    const icon = text(token?.icon)
    return {
      symbol: text(token?.symbol) ?? fallbackLabel(mint).symbol,
      ...(icon?.startsWith('https://') ? { icon } : {}),
    }
  }
}

type SwapIntent = z.infer<typeof argumentsSchema>

function describeSwap(
  input: SwapIntent,
  label: Labels = fallbackLabel,
): TransactionReview {
  const pay = label(input.inputMint)
  const receive = label(input.outputMint)
  const trade: SwapTrade = {
    kind: 'swap',
    venue: 'jupiter',
    pay: { mint: input.inputMint, ...pay, amount: input.amount },
    receive: {
      mint: input.outputMint,
      ...receive,
      ...(input.minOutputAmount === undefined
        ? {}
        : { minimum: input.minOutputAmount }),
    },
    maxSlippageBps: input.maxSlippageBps,
  }
  return {
    title: `Swap ${pay.symbol} for ${receive.symbol}`,
    description:
      'Swap from your connected wallet through Jupiter. The quote is fetched when you sign. Network fees are paid in SOL.',
    actionLabel: 'Swap tokens',
    fields: [
      {
        label: 'You pay',
        value: `${input.amount} ${pay.symbol}`,
        ...(pay.icon ? { icon: pay.icon } : {}),
      },
      {
        label: 'You receive',
        value: receive.symbol,
        ...(receive.icon ? { icon: receive.icon } : {}),
      },
      { label: 'Maximum slippage', value: `${input.maxSlippageBps / 100}%` },
      ...(input.minOutputAmount === undefined
        ? []
        : [
            {
              label: 'Minimum receive',
              value: `${input.minOutputAmount} ${receive.symbol}`,
            },
          ]),
    ],
    trade,
  }
}

const swapOperation = defineTransactionOperation({
  supportedNetworks: [SOLANA_NETWORKS.mainnet.name],
  arguments: argumentsSchema,
  describe: (input) => describeSwap(input),
  review: async (input, context: JupiterTransactionContext) =>
    describeSwap(
      input,
      await tokenLabels(context, [input.inputMint, input.outputMint]),
    ),
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
      review: withQuote(review, swap),
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

/**
 * The prepared review: the receive line becomes the quote's estimate, keeping
 * the symbol and logo the review already resolved. The trade takes the
 * quote's amounts too.
 */
function withQuote(
  review: TransactionReview,
  swap: {
    expectedOutput: { decimal: string }
    minimumOutput: { decimal: string } | null
  },
): TransactionReview {
  const receive = review.fields.find((field) => field.label === 'You receive')
  const symbol = receive?.value ?? ''
  const trade = review.trade?.kind === 'swap' ? review.trade : undefined
  return {
    ...review,
    ...(trade
      ? {
          trade: {
            ...trade,
            receive: {
              ...trade.receive,
              estimated: swap.expectedOutput.decimal,
              ...(swap.minimumOutput
                ? { minimum: swap.minimumOutput.decimal }
                : {}),
            },
          },
        }
      : {}),
    fields: [
      ...review.fields.filter(
        (field) =>
          field.label !== 'You receive' && field.label !== 'Minimum receive',
      ),
      {
        label: 'Estimated receive',
        value: `${swap.expectedOutput.decimal} ${symbol}`,
        ...(receive?.icon ? { icon: receive.icon } : {}),
      },
      ...(swap.minimumOutput
        ? [
            {
              label: 'Minimum receive',
              value: `${swap.minimumOutput.decimal} ${symbol}`,
            },
          ]
        : []),
    ],
  }
}

/** A wallet-funded Jupiter swap; network fees are paid in SOL by the signer. */
export const jupiterSwapTool = {
  name: 'jupiter_swap',
  title: 'Swap tokens with Jupiter',
  description:
    'Swap an exact input amount through Jupiter, in decimal token units (1 means one USDC, not one base unit). The quote is fetched when the transaction is prepared for signing. The signing wallet pays network fees in SOL.',
  transaction: swapOperation,
  programs: JUPITER_SWAP_PROGRAMS,
} as const
