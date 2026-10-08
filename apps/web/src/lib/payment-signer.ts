import {
  PaymentSignerGrant,
  PaymentSignerRefusal,
  PaymentSignerStatus,
} from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

/** The API refused a signer change; `code` says why when it matters. */
export class SignerRefusedError extends Error {
  override readonly name = 'SignerRefusedError'
  constructor(
    message: string,
    readonly code: PaymentSignerRefusal['code'],
  ) {
    super(message)
  }
}

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
    const body: unknown = await response.json().catch(() => null)
    if (response.status === 409 && PaymentSignerRefusal.allows(body))
      throw new SignerRefusedError(body.error, body.code)
    throw new Error('Could not update agent payments.')
  }
  return response.json()
}

export async function getPaymentSigner(getAccessToken: GetAccessToken) {
  return PaymentSignerStatus.assert(await call(getAccessToken, ''))
}

/**
 * Sets up agent payments: the server prepares a policy-bound signer, the
 * user's own Privy session adds it to the wallet, and the server checks
 * Privy before it allows any payment. Safe to run again at any point.
 * `restore` sets up again after the user removed LanaTools access; without
 * it the server refuses, so only the user undoes a removal.
 */
export async function attachPaymentSigner(
  getAccessToken: GetAccessToken,
  walletAddress: string,
  restore: boolean,
  {
    addSigners,
    removeSigners,
  }: {
    addSigners: (input: {
      address: string
      signers: Array<{ signerId: string; policyIds: string[] }>
    }) => Promise<unknown>
    removeSigners: (input: { address: string }) => Promise<unknown>
  },
) {
  const grant = PaymentSignerGrant.assert(
    await call(getAccessToken, '/prepare', {
      method: 'POST',
      body: JSON.stringify({ walletAddress, restore }),
    }),
  )
  const confirm = async () =>
    PaymentSignerStatus.assert(
      await call(getAccessToken, '/confirm', { method: 'POST' }),
    )
  const add = () => addSigners({ address: walletAddress, signers: [grant] })
  try {
    await add()
  } catch {
    // Privy refuses a signer that is already on the wallet. With this
    // setup's policy, as after another tab or an attempt that stopped early,
    // the server's check turns payments on. With another policy, as from an
    // earlier setup or another LanaTools deployment on the same Privy app,
    // the old signer is replaced. LanaTools adds no other signer to the
    // wallet, so removing all of them removes only its own. Any other
    // refusal, such as access removed meanwhile, leaves the wallet alone.
    try {
      return await confirm()
    } catch (refusal) {
      if (
        !(refusal instanceof SignerRefusedError) ||
        refusal.code !== 'signer-not-attached'
      )
        throw refusal
      await removeSigners({ address: walletAddress })
      await add()
    }
  }
  return confirm()
}

/**
 * Removes LanaTools access. The server stop goes first, so no client can
 * start a payment even if removing the signer from the wallet then fails.
 */
export async function removePaymentSigner(
  getAccessToken: GetAccessToken,
  walletAddress: string,
  removeSigners: (input: { address: string }) => Promise<unknown>,
) {
  const status = PaymentSignerStatus.assert(
    await call(getAccessToken, '/disable', { method: 'POST' }),
  )
  try {
    await removeSigners({ address: walletAddress })
  } catch (cause) {
    throw new Error(
      'Payments are stopped, but Privy could not remove the LanaTools signer from your wallet. Try again.',
      { cause },
    )
  }
  return status
}
