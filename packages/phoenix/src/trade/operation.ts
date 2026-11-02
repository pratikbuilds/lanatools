import { z } from 'zod'
import {
  address,
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import {
  defineTransactionOperation,
  TransactionNotSubmittedError,
  TransactionPreparationError,
} from '@lanatools/toolkit/transactions'
import type { TransactionContext } from '@lanatools/toolkit/transactions'
import { PerpTrade } from '@lanatools/contracts'
import { TRADE_PROGRAMS } from './checks'
import { runTradeTool } from './tool'
import type { TradeOpts, TradeTool } from './tool'
import { relayReferralTransaction } from './submit'
import { readSigned, rpcTimeout } from './transaction'

export type PhoenixTransactionContext = TransactionContext & TradeOpts

const Execution = z.strictObject({
  expiresAfterSlot: z.string().regex(/^\d+$/).optional(),
  submit: z.discriminatedUnion('via', [
    z.strictObject({ via: z.literal('rpc') }),
    z.strictObject({
      via: z.literal('phoenix-referral'),
      referralCode: z.string().min(1),
      recentBlockhash: z.string().min(1),
      login: z.strictObject({
        message: z.string().min(1),
        nonceId: z.string().min(1),
      }),
    }),
  ]),
})

type Arguments = Record<string, unknown>
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const flag = (value: unknown) =>
  typeof value === 'boolean' ? value : undefined
const side = (value: unknown) =>
  value === 'buy' || value === 'sell' ? value : undefined

/**
 * What each tool asks for, as trade data, before Phoenix's book is read. The
 * prepared transaction replaces it with the tool's own, exact terms.
 */
const INTENTS: Record<string, (input: Arguments) => Arguments> = {
  phoenix_activate_account: () => ({ action: 'activate' }),
  phoenix_deposit: (input) => ({
    action: 'deposit',
    amountUsdc: text(input.amount),
  }),
  phoenix_withdraw: (input) => ({
    action: 'withdraw',
    amountUsdc: text(input.amount),
  }),
  phoenix_market_order: (input) => ({
    action: 'order',
    orderType: 'market',
    symbol: text(input.symbol),
    side: side(input.side),
    size: text(input.size),
    worstPrice: text(input.limitPrice),
    reduceOnly: flag(input.reduceOnly),
  }),
  phoenix_limit_order: (input) => ({
    action: 'order',
    orderType: 'limit',
    symbol: text(input.symbol),
    side: side(input.side),
    size: text(input.size),
    limitPrice: text(input.price),
    postOnly: flag(input.postOnly),
    reduceOnly: flag(input.reduceOnly),
  }),
  phoenix_cancel_orders: (input) => ({
    action: 'cancel',
    symbol: text(input.symbol),
    cancelled: Array.isArray(input.orderIds)
      ? input.orderIds.length
      : undefined,
  }),
  phoenix_close_position: (input) => ({
    action: 'close',
    orderType: 'market',
    symbol: text(input.symbol),
    worstPrice: text(input.limitPrice),
    reduceOnly: true,
  }),
}

function intendedTrade(tool: string, input: Arguments) {
  const intent = INTENTS[tool]
  if (!intent) return undefined
  const terms = Object.entries(intent(input)).filter(
    ([, value]) => value !== undefined,
  )
  return PerpTrade.assert({
    kind: 'perp',
    venue: 'phoenix',
    ...Object.fromEntries(terms),
  })
}

/** Adapt the checked trade builders to every LanaTools signing path. */
export function phoenixTransactionTool<TSchema extends z.ZodObject>(
  tool: TradeTool<TSchema> & { arguments: z.ZodObject },
) {
  const activation = tool.name === 'phoenix_activate_account'
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description.replace(
      'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
      'Uses the selected transaction delivery mode. Mainnet only. Once it confirms, give the user result.accountUrl: a public page of their Phoenix account that needs no login.',
    ),
    programs: [
      'ComputeBudget111111111111111111111111111111',
      ...(tool.programs ?? TRADE_PROGRAMS),
    ],
    transaction: defineTransactionOperation({
      arguments: tool.arguments,
      supportedNetworks: ['mainnet'],
      resubmit: !activation,
      describe: (input) => {
        const trade = intendedTrade(tool.name, input)
        return {
          title: tool.title,
          description: activation
            ? 'Activate your Phoenix account. Your wallet pays rent and fees in SOL and signs a Phoenix login message. Phoenix co-signs and submits.'
            : 'Use your Phoenix cross-margin account. Exact terms are checked and simulated when prepared. Network fees are paid in SOL.',
          actionLabel: tool.title,
          fields: Object.entries(input)
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => ({
              label,
              value: Array.isArray(value) ? value.join(', ') : String(value),
            })),
          ...(trade ? { trade } : {}),
        }
      },
      async build(input, account, context: PhoenixTransactionContext, review) {
        const outcome = await runTradeTool(
          tool,
          { ...input, wallet: account },
          context,
        )
        if (!outcome.ok) {
          if (outcome.error.retryable) throw new Error(outcome.error.message)
          throw new TransactionPreparationError(outcome.error.message)
        }
        const result = outcome.result
        if (result.status === 'nothing_to_do')
          throw new TransactionPreparationError(result.summary)
        if (result.status === 'simulation_failed')
          throw new TransactionPreparationError(
            `Phoenix simulation failed: ${result.simulation.error ?? 'transaction refused'}`,
          )
        if (
          result.submit.via === 'phoenix-referral' &&
          !result.submit.login.message.startsWith(
            `phoenix-wallet-login-v1\nwallet:${account}\nnonce:${result.submit.login.nonceId}\nexpires_at:`,
          )
        )
          throw new Error('Phoenix returned an unsupported login challenge')
        const decoded = getTransactionDecoder().decode(
          getBase64Encoder().encode(result.transaction),
        )
        const message = getCompiledTransactionMessageDecoder().decode(
          decoded.messageBytes,
        )
        const signers = Object.keys(decoded.signatures)
        if (
          result.wallet !== account ||
          message.staticAccounts[0] !== account ||
          signers[0] !== account ||
          signers.some(
            (signer) => decoded.signatures[address(signer)] !== null,
          ) ||
          (activation ? signers.length !== 2 : signers.length !== 1) ||
          (activation
            ? result.submit.via !== 'phoenix-referral'
            : result.submit.via !== 'rpc')
        )
          throw new Error('Unsupported Phoenix signing policy')
        return {
          transaction: result.transaction,
          account,
          network: context.network,
          blockhash: message.lifetimeToken,
          lastValidBlockHeight: result.lastValidBlockHeight,
          review: {
            ...review,
            description: result.summary,
            trade: result.trade,
            fields: [
              ...Object.entries(result.details).map(([label, value]) => ({
                label,
                value,
              })),
              ...result.warnings.map((value) => ({ label: 'Notice', value })),
              {
                label: 'Confirmation',
                value:
                  'A confirmed transaction does not guarantee a full fill or a completed withdrawal. Check your Phoenix account after confirmation.',
              },
            ],
          },
          ...(result.submit.via === 'phoenix-referral'
            ? {
                coSigners: signers.slice(1),
                messageToSign: result.submit.login.message,
              }
            : {}),
          execution: {
            submit: result.submit,
            ...(result.expiresAfterSlot
              ? { expiresAfterSlot: result.expiresAfterSlot }
              : {}),
          },
        }
      },
      submission: {
        schema: Execution,
        async send(wire, candidate, execution, context, messageSignature) {
          if (execution.submit.via === 'phoenix-referral') {
            const result = await relayReferralTransaction(
              {
                wallet: address(candidate.account),
                transaction: candidate.transaction,
                submit: execution.submit,
              },
              {
                transaction: wire,
                ...(messageSignature
                  ? { loginSignature: messageSignature }
                  : {}),
              },
              context,
            )
            if (result.status === 'failed')
              throw new TransactionNotSubmittedError(result.error)
            if (result.status === 'unknown') throw new Error(result.error)
            return result.signature
          }
          const signed = await readSigned(wire, {
            prepared: candidate.transaction,
          })
          if (
            execution.expiresAfterSlot !== undefined &&
            (await context.rpc
              .getSlot({ commitment: 'processed' })
              .send(rpcTimeout())) > BigInt(execution.expiresAfterSlot)
          )
            throw new TransactionNotSubmittedError(
              'The Phoenix order expired before submission. Prepare a new transaction.',
            )
          try {
            return await context.rpc
              .sendTransaction(signed.wire, {
                encoding: 'base64',
                preflightCommitment: 'confirmed',
                skipPreflight: false,
              })
              .send(rpcTimeout())
          } catch (error) {
            if (
              isSolanaError(
                error,
                SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
              ) &&
              !isSolanaError(
                error.cause,
                SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
              )
            )
              throw new TransactionNotSubmittedError(
                'The RPC refused the Phoenix transaction before broadcast.',
              )
            throw error
          }
        },
      },
    }),
  }
}
