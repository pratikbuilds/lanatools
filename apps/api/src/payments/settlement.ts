import { Receipt } from 'mppx'
import type { FixedCharge } from './challenge'

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/

/**
 * The transaction signature a paid response names, or null. MPP returns a
 * `Payment-Receipt`. Standard x402 returns base64 JSON in `Payment-Response`;
 * pay's gateway puts the raw signature there instead, so both are accepted.
 * It is recorded as the payment's reference; it is not checked on chain.
 */
export function receiptSignature(
  response: Response,
  protocol: FixedCharge['protocol'],
): string | null {
  try {
    if (protocol === 'mpp') {
      const header = response.headers.get('payment-receipt')
      if (!header) return null
      const receipt = Receipt.deserialize(header)
      return SIGNATURE.test(receipt.reference) ? receipt.reference : null
    }
    const header =
      response.headers.get('payment-response') ??
      response.headers.get('x-payment-response')
    if (!header) return null
    if (SIGNATURE.test(header)) return header
    const settled = JSON.parse(atob(header)) as {
      success?: unknown
      transaction?: unknown
    }
    return settled.success !== false &&
      typeof settled.transaction === 'string' &&
      SIGNATURE.test(settled.transaction)
      ? settled.transaction
      : null
  } catch {
    return null
  }
}

/**
 * Why an endpoint refused a signed payment, from what its answer names. An
 * x402 v2 endpoint puts the reason in the `error` of its `Payment-Required`
 * header; many also send a request ID for their support.
 */
export function refusalDetails(response: Response) {
  let reason: string | null = null
  try {
    const header = response.headers.get('payment-required')
    if (header) {
      const required = JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
        ),
      ) as { error?: unknown }
      if (typeof required.error === 'string')
        reason = required.error.slice(0, 200)
    }
  } catch {
    // An unreadable header names no reason.
  }
  const requestId = response.headers.get('x-request-id')?.slice(0, 100) ?? null
  return { reason, requestId }
}
