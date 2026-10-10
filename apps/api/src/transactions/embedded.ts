import { and, eq, isNotNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { PrivyClient } from '@privy-io/node'
import type { D1Database } from '@cloudflare/workers-types'
import { paymentSigner } from '../db/schema'
import { PolicyDeniedError, isPolicyDenial } from '../payments/privy-signer'

/** The user's LanaTools wallet, when the transaction signer is on for it. */
export type EmbeddedWallet = { walletId: string; walletAddress: string }

/** Signs base64 transaction bytes with the user's wallet; returns signed bytes. */
export type EmbeddedSigner = (
  wallet: EmbeddedWallet,
  transaction: string,
) => Promise<string>

export type EmbeddedSignerEnv = {
  PRIVY_APP_ID?: string
  PRIVY_APP_SECRET?: string
  PRIVY_TRANSACTION_SIGNER_KEY?: string
}

/**
 * The wallet embedded transactions sign with: set up, not removed by the
 * user, and with a transaction policy. Removing LanaTools access stops these
 * as it stops payments.
 */
export async function embeddedWallet(
  database: D1Database,
  userId: string,
): Promise<EmbeddedWallet | null> {
  const row = await drizzle(database)
    .select({
      walletId: paymentSigner.walletId,
      walletAddress: paymentSigner.walletAddress,
    })
    .from(paymentSigner)
    .where(
      and(
        eq(paymentSigner.privyUserId, userId),
        eq(paymentSigner.status, 'enabled'),
        isNotNull(paymentSigner.transactionPolicyId),
      ),
    )
    .get()
  return row ?? null
}

/**
 * Signs with the transaction signer's key. Privy applies that signer's
 * policy, so it signs only the programs LanaTools transaction tools call.
 * Null when this deployment has no transaction signer.
 */
export function privyEmbeddedSigner(
  env: EmbeddedSignerEnv,
): EmbeddedSigner | null {
  const { PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_TRANSACTION_SIGNER_KEY } = env
  if (!PRIVY_APP_ID || !PRIVY_APP_SECRET || !PRIVY_TRANSACTION_SIGNER_KEY)
    return null
  const privy = new PrivyClient({
    appId: PRIVY_APP_ID,
    appSecret: PRIVY_APP_SECRET,
  })
  return async ({ walletId }, transaction) => {
    try {
      return (
        await privy
          .wallets()
          .solana()
          .signTransaction(walletId, {
            transaction,
            authorization_context: {
              authorization_private_keys: [PRIVY_TRANSACTION_SIGNER_KEY],
            },
          })
      ).signed_transaction
    } catch (error) {
      if (isPolicyDenial(error))
        throw new PolicyDeniedError('Privy policy denied the transaction', {
          cause: error,
        })
      throw error
    }
  }
}
