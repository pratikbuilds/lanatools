import { getBase64Decoder, getBase64Encoder } from '@solana/kit'
import { WithdrawalReceipt, WithdrawalTransaction } from '@lanatools/contracts'
import type { WithdrawalRequest } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

/** Signs transaction bytes with the user's wallet; the browser's part. */
export type SignTransaction = (transaction: Uint8Array) => Promise<Uint8Array>

/**
 * Parses a USDC amount such as "1.50" into base units (six decimals), or
 * null for anything else, including zero and more than six decimals.
 */
export function parseUsdcAmount(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!match) return null
  const [, whole = '0', fraction = ''] = match
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  return units > 0n ? units : null
}

/** Formats base units for the amount field: no grouping, at least cents. */
export function formatUsdcAmount(units: bigint) {
  const whole = units / 1_000_000n
  const fraction = (units % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0')
  return `${whole}.${fraction}`
}

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
    throw new Error(
      response.status === 409 && typeof failure?.error === 'string'
        ? failure.error
        : 'Could not send the withdrawal. Try again.',
    )
  }
  return response.json()
}

/**
 * Withdraws USDC: the API builds the transfer, the user's wallet signs it
 * here, and the API sends it and waits for the network to confirm it.
 */
export async function withdrawUsdc(
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
  return WithdrawalReceipt.assert(
    await post(getAccessToken, '/send', {
      transaction: getBase64Decoder().decode(signed),
    } satisfies WithdrawalTransaction),
  )
}
