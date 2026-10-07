import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { APIError } from '@privy-io/node'
import type { D1Database } from '@cloudflare/workers-types'
import { walletSignerRemoval } from '../db/schema'
import { SignerSetupError } from './signer-setup-error'

type AdditionalSigner = {
  signer_id: string
  override_policy_ids?: string[]
}
type SignerWallet = {
  address: string
  additional_signers: AdditionalSigner[]
}

export interface SignerWalletClient {
  wallets: () => {
    list: (input: { user_id: string; chain_type: 'solana' }) => AsyncIterable<{
      id: string
      address: string
    }>
    get: (walletId: string) => Promise<SignerWallet>
    update: (
      walletId: string,
      input: {
        additional_signers: AdditionalSigner[]
        authorization_context: { user_jwts: string[] }
      },
    ) => Promise<SignerWallet>
  }
}

export async function ownedWallet(
  privy: Pick<SignerWalletClient, 'wallets'>,
  userId: string,
  walletId: string,
  walletAddress: string,
) {
  let owned = false
  for await (const wallet of privy
    .wallets()
    .list({ user_id: userId, chain_type: 'solana' }))
    if (wallet.id === walletId && wallet.address === walletAddress) owned = true
  if (!owned)
    throw new SignerSetupError('That wallet is not your embedded wallet')
  const wallet = await privy.wallets().get(walletId)
  if (wallet.address !== walletAddress)
    throw new SignerSetupError(
      'Your embedded wallet changed. Refresh and try again.',
    )
  return wallet
}

function fingerprint(signers: AdditionalSigner[]) {
  return JSON.stringify(
    signers
      .map((signer) => ({
        signer_id: signer.signer_id,
        override_policy_ids: signer.override_policy_ids
          ? [...signer.override_policy_ids].sort()
          : null,
      }))
      .sort((a, b) => a.signer_id.localeCompare(b.signer_id)),
  )
}

/** Owner-authorized list replacement; Privy does not expose a CAS revision. */
export async function removeOwnedSigner(
  database: D1Database,
  privy: SignerWalletClient,
  input: {
    userId: string
    walletId: string
    walletAddress: string
    signerId: string
    policyId: string
    userAccessToken: string
  },
) {
  const token = crypto.randomUUID()
  const [claimed] = await drizzle(database)
    .insert(walletSignerRemoval)
    .values({
      walletId: input.walletId,
      privyUserId: input.userId,
      signerId: input.signerId,
      token,
      createdAt: Date.now(),
    })
    .onConflictDoNothing()
    .returning()
  if (!claimed)
    throw new SignerSetupError(
      'Another signer removal is in progress or needs verification. Execution stays off.',
    )
  let updateInFlight = false
  try {
    const before = await ownedWallet(
      privy,
      input.userId,
      input.walletId,
      input.walletAddress,
    )
    const target = before.additional_signers.find(
      (signer) => signer.signer_id === input.signerId,
    )
    if (!target) return
    if (
      target.override_policy_ids?.length !== 1 ||
      target.override_policy_ids[0] !== input.policyId
    )
      throw new SignerSetupError(
        'Signer policy changed. Execution stays off; review your wallet permissions.',
      )
    if (
      new Set(before.additional_signers.map((signer) => signer.signer_id))
        .size !== before.additional_signers.length
    )
      throw new SignerSetupError(
        'Wallet signer state is inconsistent. Refresh and try again.',
      )
    const remaining = before.additional_signers
      .filter((signer) => signer.signer_id !== input.signerId)
      .map((signer) => ({
        signer_id: signer.signer_id,
        ...(signer.override_policy_ids
          ? { override_policy_ids: [...signer.override_policy_ids] }
          : {}),
      }))
    const latest = await privy.wallets().get(input.walletId)
    if (
      latest.address !== input.walletAddress ||
      fingerprint(latest.additional_signers) !==
        fingerprint(before.additional_signers)
    )
      throw new SignerSetupError(
        'Wallet signers changed. Refresh and retry removal.',
      )
    updateInFlight = true
    await privy.wallets().update(input.walletId, {
      additional_signers: remaining,
      authorization_context: { user_jwts: [input.userAccessToken] },
    })
    updateInFlight = false
    const after = await privy.wallets().get(input.walletId)
    if (
      after.address !== input.walletAddress ||
      fingerprint(after.additional_signers) !== fingerprint(remaining)
    )
      throw new SignerSetupError(
        'Signer removal could not be verified. Execution stays off; refresh and retry.',
      )
  } catch (error) {
    if (
      error instanceof APIError &&
      error.status &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408
    )
      updateInFlight = false
    if (updateInFlight)
      throw new SignerSetupError(
        'Signer removal outcome is unknown. Execution stays off; the wallet needs review before another signer change.',
      )
    if (error instanceof SignerSetupError) throw error
    throw new SignerSetupError(
      'Execution is off, but Privy signer removal did not complete. Retry removal.',
    )
  } finally {
    if (!updateInFlight)
      await drizzle(database)
        .delete(walletSignerRemoval)
        .where(
          and(
            eq(walletSignerRemoval.walletId, input.walletId),
            eq(walletSignerRemoval.token, token),
          ),
        )
  }
}

export async function assertNoSignerRemoval(
  database: D1Database,
  walletId: string,
) {
  const removal = await drizzle(database)
    .select()
    .from(walletSignerRemoval)
    .where(eq(walletSignerRemoval.walletId, walletId))
    .get()
  if (removal)
    throw new SignerSetupError(
      'Signer removal is in progress or needs verification. Finish removal before setup.',
    )
}
