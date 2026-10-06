import {
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
} from '@solana/kit'
import { ExternalTransferReview } from '@lanatools/contracts'

export function tokenFromFragment(fragment: string) {
  const token = new URLSearchParams(fragment.replace(/^#/, '')).get('token')
  return token !== null && /^[a-f0-9]{64}$/.test(token) ? token : null
}

export async function callTransferLink(
  token: string,
  action: 'review' | 'prepare' | 'submit',
  body?: { walletAddress: string } | { signedBase64: string },
) {
  const response = await fetch(
    `/api/transactions/link${action === 'review' ? '' : `/${action}`}`,
    {
      method: action === 'review' ? 'GET' : 'POST',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  )
  const payload: unknown = await response.json()
  if (!response.ok) {
    throw new Error(
      typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'string'
        ? payload.error
        : 'Could not load this transfer.',
    )
  }
  return ExternalTransferReview.assert(payload)
}

export function exactSOL(lamports: string) {
  if (!/^\d+$/.test(lamports)) throw new Error('Invalid transfer amount.')
  const value = BigInt(lamports)
  const fraction = (value % 1_000_000_000n)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '')
  return `${value / 1_000_000_000n}${fraction ? `.${fraction}` : ''}`
}

export function signedWireForSubmit(
  unsignedBase64: string,
  signed: Uint8Array,
) {
  const original = getTransactionDecoder().decode(
    getBase64Encoder().encode(unsignedBase64),
  )
  const returned = getTransactionDecoder().decode(signed)
  if (
    original.messageBytes.length !== returned.messageBytes.length ||
    !original.messageBytes.every(
      (byte, index) => byte === returned.messageBytes[index],
    )
  )
    throw new Error(
      'The wallet changed the reviewed transaction. Nothing was submitted.',
    )
  return getBase64Decoder().decode(signed)
}

export function transferStatus(review: ExternalTransferReview) {
  if (review.state === 'succeeded')
    return review.commitment === 'finalized' ? 'Finalized' : 'Confirmed'
  if (review.state === 'submitted') return 'Submitted — awaiting confirmation'
  if (review.state === 'failed' || review.state === 'refused') return 'Failed'
  if (review.state === 'expired') return 'Expired'
  if (['signed', 'submitting', 'uncertain'].includes(review.state))
    return 'Unknown outcome — check status before taking another action'
  if (review.transactionExpired)
    return 'Transaction expired — outcome may still be unknown'
  return 'Awaiting your approval'
}
