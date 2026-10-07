import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { paymentSigner } from '../db/schema'
import { signerStatus, SignerSetupError } from './signer-setup'
import { removeOwnedSigner } from './selective-signer'
import type { SignerWalletClient } from './selective-signer'

export async function disablePaymentDelegation(
  database: D1Database,
  privy: SignerWalletClient,
  input: {
    userId: string
    walletAddress: string
    signerId: string
    userAccessToken: string
  },
) {
  const [row] = await drizzle(database)
    .update(paymentSigner)
    .set({ status: 'disabled', updatedAt: Date.now() })
    .where(eq(paymentSigner.privyUserId, input.userId))
    .returning()
  if (!row) return signerStatus(database, input.userId)
  if (row.walletAddress !== input.walletAddress)
    throw new SignerSetupError(
      'Payments are off. Refresh your wallet before removing its signer.',
    )
  await removeOwnedSigner(database, privy, {
    ...input,
    walletId: row.walletId,
    policyId: row.policyId,
  })
  return signerStatus(database, input.userId)
}
