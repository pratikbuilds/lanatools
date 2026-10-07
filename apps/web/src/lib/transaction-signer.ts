import {
  TransactionSignerGrant,
  TransactionSignerStatus,
} from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'
import type { enablePaymentSigner } from './payment-signer'

async function call(
  getAccessToken: GetAccessToken,
  path: string,
  body?: object,
) {
  const response = await fetch(`/api/transactions/signer${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(await authorized(getAccessToken)),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const payload: unknown = await response.json()
  if (!response.ok)
    throw new Error(
      typeof payload === 'object' &&
        payload !== null &&
        'error' in payload &&
        typeof payload.error === 'string'
        ? payload.error
        : 'Could not update automatic SOL transfers.',
    )
  return payload
}

export async function getTransactionSigner(getAccessToken: GetAccessToken) {
  return TransactionSignerStatus.assert(await call(getAccessToken, ''))
}

export async function enableTransactionSigner(
  getAccessToken: GetAccessToken,
  walletAddress: string,
  addSigners: Parameters<typeof enablePaymentSigner>[2],
) {
  const grant = TransactionSignerGrant.assert(
    await call(getAccessToken, '/prepare', { walletAddress }),
  )
  const confirm = async () =>
    TransactionSignerStatus.assert(
      await call(getAccessToken, '/confirm', { walletAddress }),
    )
  try {
    await addSigners({ address: walletAddress, signers: [grant] })
  } catch (cause) {
    try {
      return await confirm()
    } catch {
      throw cause
    }
  }
  return confirm()
}

export async function disableTransactionSigner(
  getAccessToken: GetAccessToken,
  walletAddress: string,
) {
  return TransactionSignerStatus.assert(
    await call(getAccessToken, '/disable', { walletAddress }),
  )
}
