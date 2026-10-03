import { PaymentSignerGrant, PaymentSignerStatus } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

async function call(
  getAccessToken: GetAccessToken,
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(`/api/payments/signer${path}`, {
    ...init,
    headers: {
      ...(await authorized(getAccessToken)),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown
    } | null
    throw new Error(
      response.status === 409 && typeof body?.error === 'string'
        ? body.error
        : 'Could not update agent payments.',
    )
  }
  return response.json()
}

export async function getPaymentSigner(getAccessToken: GetAccessToken) {
  return PaymentSignerStatus.assert(await call(getAccessToken, ''))
}

/**
 * Turns on agent payments: the server prepares a policy-bound signer, the
 * user's own Privy session attaches it to the wallet, and the server checks
 * Privy before it allows any payment.
 */
export async function enablePaymentSigner(
  getAccessToken: GetAccessToken,
  walletAddress: string,
  addSigners: (input: {
    address: string
    signers: Array<{ signerId: string; policyIds: string[] }>
  }) => Promise<unknown>,
) {
  const grant = PaymentSignerGrant.assert(
    await call(getAccessToken, '/prepare', {
      method: 'POST',
      body: JSON.stringify({ walletAddress }),
    }),
  )
  const confirm = async () =>
    PaymentSignerStatus.assert(
      await call(getAccessToken, '/confirm', { method: 'POST' }),
    )
  try {
    await addSigners({ address: walletAddress, signers: [grant] })
  } catch (error) {
    // Privy refuses a signer that is already on the wallet, as after another
    // tab or an attempt that stopped before the check below. The server's
    // check decides; if it disagrees, Privy's refusal is the failure.
    try {
      return await confirm()
    } catch {
      throw error
    }
  }
  return confirm()
}

/**
 * Stops agent payments. The server switch goes first, so no client can
 * start a payment even if removing the signer from the wallet fails.
 */
export async function disablePaymentSigner(
  getAccessToken: GetAccessToken,
  walletAddress: string,
  removeSigners: (input: { address: string }) => Promise<unknown>,
) {
  const status = PaymentSignerStatus.assert(
    await call(getAccessToken, '/disable', { method: 'POST' }),
  )
  await removeSigners({ address: walletAddress })
  return status
}
