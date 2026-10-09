import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import type { z } from 'zod'
import type { BuildSwapInput } from '../inputs'
import type { ReadContext } from '../client'
import { JupiterReadError, unavailable } from '../client'
import type { BuildSwapData } from '../types'
import { swapOrder } from '../swap'

export async function buildSwap(
  context: ReadContext,
  input: z.output<typeof BuildSwapInput>,
  policy?: { excludeRfq: true },
): Promise<BuildSwapData> {
  const { quote, raw } = await swapOrder(context, input, input.wallet, policy)
  if (policy?.excludeRfq && quote.router === 'jupiterz')
    throw unavailable('Jupiter returned an excluded swap router')
  if (quote.constraints.satisfied === false)
    throw new JupiterReadError({
      code: 'no_route',
      message:
        'Jupiter did not return a swap satisfying the requested constraints',
      retryable: false,
    })
  if (
    (input.maxSlippageBps !== undefined ||
      input.minOutputAmount !== undefined) &&
    quote.constraints.satisfied !== true
  )
    throw unavailable(
      'Jupiter omitted fields needed to confirm swap constraints',
    )

  if (
    typeof raw.transaction !== 'string' ||
    !raw.transaction ||
    raw.transaction.length > 1644 ||
    typeof raw.requestId !== 'string' ||
    !raw.requestId.trim() ||
    !quote.router ||
    raw.taker !== input.wallet
  )
    throw unavailable('Jupiter did not return a usable swap transaction')

  try {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        raw.transaction,
      )
    )
      throw new Error('Invalid base64')
    const bytes = getBase64Encoder().encode(raw.transaction)
    const transaction = getTransactionDecoder().decode(bytes)
    const [message, end] = getCompiledTransactionMessageDecoder().read(
      transaction.messageBytes,
      0,
    )
    if (
      bytes.length > 1232 ||
      end !== transaction.messageBytes.length ||
      message.version !== 0 ||
      transaction.signatures[input.wallet] !== null
    )
      throw new Error('Unsupported transaction or wallet signer')
  } catch {
    throw unavailable(
      'Jupiter returned an invalid or unsupported swap transaction',
    )
  }

  if (
    (raw.lastValidBlockHeight != null &&
      (typeof raw.lastValidBlockHeight !== 'string' ||
        !/^\d+$/.test(raw.lastValidBlockHeight))) ||
    (raw.expireAt != null &&
      (typeof raw.expireAt !== 'string' ||
        !Number.isFinite(Date.parse(raw.expireAt))))
  )
    throw unavailable('Jupiter returned unusable transaction expiry metadata')

  context.warnings.push(
    'Transaction preparation only; no signing, simulation or submission was performed. Prices and transaction validity may change.',
  )
  if (quote.router === 'jupiterz')
    context.warnings.push(
      'JupiterZ requires an additional market-maker signature through Jupiter execution.',
    )

  return {
    ...quote,
    wallet: input.wallet,
    transaction: raw.transaction,
    requestId: raw.requestId,
    lastValidBlockHeight: raw.lastValidBlockHeight ?? null,
    expireAt: raw.expireAt ?? null,
  }
}
