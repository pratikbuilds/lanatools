import {
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
} from '@solana/kit'
import { WithdrawalReceipt, WithdrawalTransaction } from '@lanatools/contracts'
import type { WithdrawalRequest } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

/** Signs transaction bytes with the user's wallet; the browser's part. */
export type SignTransaction = (transaction: Uint8Array) => Promise<Uint8Array>

/** Parses a positive amount exactly, using the selected token's decimals. */
export function parseTokenAmount(value: string, decimals = 6): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  const [, whole = '0', fraction = ''] = match
  if (fraction.length > decimals) return null
  const units =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  return units > 0n && units <= 18_446_744_073_709_551_615n ? units : null
}

/** Exact decimal text for an amount field, without grouping or rounding. */
export function formatTokenAmount(units: bigint, decimals = 6) {
  const base = 10n ** BigInt(decimals)
  const fraction = (units % base)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  return `${units / base}${decimals ? `.${fraction.padEnd(Math.min(2, decimals), '0')}` : ''}`
}

class WithdrawalRefused extends Error {}

async function post(
  getAccessToken: GetAccessToken,
  path: string,
  body: unknown,
) {
  const response = await fetch(`/api/wallet/withdrawals${path}`, {
    method: 'POST',
    headers: {
      ...(await authorized(getAccessToken)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as {
      error?: unknown
    } | null
    if (response.status === 409 && typeof failure?.error === 'string')
      throw new WithdrawalRefused(failure.error)
    throw new Error('Could not send the withdrawal. Try again.')
  }
  return response.json()
}

/**
 * Withdraws the selected token: the API builds the transfer, the user's wallet signs it
 * here, and the API sends it and waits for the network to confirm it.
 */
export async function withdrawToken(
  getAccessToken: GetAccessToken,
  request: WithdrawalRequest,
  sign: SignTransaction,
) {
  const prepared = WithdrawalTransaction.assert(
    await post(getAccessToken, '/prepare', request),
  )
  const signed = await sign(
    new Uint8Array(getBase64Encoder().encode(prepared.transaction)),
  )
  try {
    return WithdrawalReceipt.assert(
      await post(getAccessToken, '/send', {
        transaction: getBase64Decoder().decode(signed),
      } satisfies WithdrawalTransaction),
    )
  } catch (error) {
    if (error instanceof WithdrawalRefused) throw error
    // A lost response may follow a broadcast. Preserve its signature instead of offering another send.
    return {
      signature: getSignatureFromTransaction(
        getTransactionDecoder().decode(signed),
      ),
      confirmed: false,
    }
  }
}
