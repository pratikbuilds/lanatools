import { SignerSetupError } from './signer-setup-error'
import { assertNoSignerRemoval, ownedWallet } from './selective-signer'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type {
  PaymentSignerGrant,
  PaymentSignerStatus,
} from '@lanatools/contracts'
import type { PrivyClient } from '@privy-io/node'
import { paymentSigner, walletSignerRemoval } from '../db/schema'
import type { PaymentNetwork } from '../solana/network'

export { SignerSetupError }

const PREPARING = 'preparing:'
const noRemoval = (walletId: string) =>
  sql`not exists (select 1 from ${walletSignerRemoval} where ${walletSignerRemoval.walletId} = ${walletId})`

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

/**
 * The Privy wallet ID of `walletAddress` if it is one of the user's own
 * Solana wallets, else undefined. Privy's word, not the browser's.
 */
export async function findUserWallet(
  privy: PrivyClient,
  userId: string,
  walletAddress: string,
) {
  for await (const wallet of privy
    .wallets()
    .list({ user_id: userId, chain_type: 'solana' }))
    if (wallet.address === walletAddress) return wallet.id
  return undefined
}

export async function signerStatus(
  database: D1Database,
  userId: string,
): Promise<PaymentSignerStatus> {
  const row = await drizzle(database)
    .select()
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, userId))
    .get()
  return row
    ? { status: row.status, walletAddress: row.walletAddress }
    : { status: 'none', walletAddress: null }
}

/**
 * Prepares the LanaTools server signer for the user's embedded wallet: finds
 * the wallet among the user's own Privy wallets and creates a user-owned
 * policy that allows only USDC transfers plus Compute Budget and Memo
 * instructions. How much may be paid is enforced by each client's limit in
 * D1, not by this policy. The browser then adds the signer with Privy, as
 * only the wallet's owner can.
 */
export async function prepareSigner(
  database: D1Database,
  privy: PrivyClient,
  {
    userId,
    walletAddress,
    signerId,
    network,
  }: {
    userId: string
    walletAddress: string
    signerId: string
    network: PaymentNetwork
  },
  now = Date.now(),
): Promise<PaymentSignerGrant> {
  const walletId = await findUserWallet(privy, userId, walletAddress)
  if (!walletId)
    throw new SignerSetupError('That wallet is not your embedded wallet')

  const db = drizzle(database)
  const existing = await db
    .select()
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, userId))
    .get()
  await assertNoSignerRemoval(database, walletId)
  if (existing?.status === 'disabled') {
    await assertNoSignerRemoval(database, existing.walletId)
    const previous = await ownedWallet(
      privy,
      userId,
      existing.walletId,
      existing.walletAddress,
    )
    if (
      previous.additional_signers.some(
        (signer) => signer.signer_id === signerId,
      )
    )
      throw new SignerSetupError(
        'Remove the remaining payment signer before enabling payments again',
      )
  }
  // A setup that is unfinished or already on (say, from another tab) keeps
  // its policy and status. Turning payments on again after they were turned
  // off creates a fresh policy, so a wallet never keeps older rules.
  if (existing?.walletId === walletId && existing.status !== 'disabled') {
    if (existing.policyId.startsWith(PREPARING))
      throw new SignerSetupError(
        'Payment setup outcome is pending or unknown. Turn it off before retrying.',
      )
    return { signerId, policyIds: [existing.policyId] }
  }

  const claim = PREPARING + crypto.randomUUID()
  const pending = {
    walletId,
    walletAddress,
    policyId: claim,
    status: 'pending' as const,
    updatedAt: now,
  }
  const [claimed] = await db
    .insert(paymentSigner)
    .values({ privyUserId: userId, ...pending })
    .onConflictDoUpdate({
      target: paymentSigner.privyUserId,
      set: pending,
      setWhere: sql`${and(
        eq(paymentSigner.status, 'disabled'),
        eq(paymentSigner.policyId, existing?.policyId ?? ''),
        eq(paymentSigner.walletId, existing?.walletId ?? ''),
        noRemoval(walletId),
        noRemoval(existing?.walletId ?? walletId),
      )}`,
    })
    .returning()
  if (!claimed)
    throw new SignerSetupError('Payment setup changed. Refresh and try again.')

  const policy = await privy.policies().create({
    name: 'LanaTools agent payments',
    version: '1.0',
    chain_type: 'solana',
    owner: { user_id: userId },
    rules: [
      {
        name: 'Allow payment compute budget and memo',
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_program_instruction',
            field: 'programId',
            operator: 'in',
            value: [COMPUTE_BUDGET, MEMO],
          },
        ],
      },
      {
        name: 'Allow USDC transfer to any merchant',
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_token_program_instruction',
            field: 'TransferChecked.mint',
            operator: 'eq',
            value: network.usdcMint,
          },
        ],
      },
    ],
  })
  const [prepared] = await db
    .update(paymentSigner)
    .set({ policyId: policy.id, updatedAt: Date.now() })
    .where(
      and(
        eq(paymentSigner.privyUserId, userId),
        eq(paymentSigner.policyId, claim),
        eq(paymentSigner.status, 'pending'),
        eq(paymentSigner.walletId, walletId),
        eq(paymentSigner.walletAddress, walletAddress),
        noRemoval(walletId),
      ),
    )
    .returning()
  if (!prepared)
    throw new SignerSetupError(
      'Payment setup was stopped or changed meanwhile. Refresh before continuing.',
    )
  return { signerId, policyIds: [policy.id] }
}

/**
 * Turns payments on once Privy reports the server signer on the wallet with
 * exactly the LanaTools policy. The browser's word is not enough.
 */
export async function confirmSigner(
  database: D1Database,
  privy: PrivyClient,
  userId: string,
  signerId: string,
  now = Date.now(),
): Promise<PaymentSignerStatus> {
  const db = drizzle(database)
  const row = await db
    .select()
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, userId))
    .get()
  if (!row) throw new SignerSetupError('Set up payments first')
  await assertNoSignerRemoval(database, row.walletId)
  const wallet = await privy.wallets().get(row.walletId)
  const attached = wallet.additional_signers.some(
    (signer) =>
      signer.signer_id === signerId &&
      signer.override_policy_ids?.length === 1 &&
      signer.override_policy_ids[0] === row.policyId,
  )
  if (!attached)
    throw new SignerSetupError(
      'Privy does not show the LanaTools signer on this wallet yet',
    )
  // Only the setup that was checked can be enabled: a turn-off or a new setup
  // since the read above wins.
  const [enabled] = await db
    .update(paymentSigner)
    .set({ status: 'enabled', updatedAt: now })
    .where(
      and(
        eq(paymentSigner.privyUserId, userId),
        eq(paymentSigner.policyId, row.policyId),
        inArray(paymentSigner.status, ['pending', 'enabled']),
        noRemoval(row.walletId),
      ),
    )
    .returning({ walletAddress: paymentSigner.walletAddress })
  if (!enabled)
    throw new SignerSetupError(
      'Payments were turned off or set up again meanwhile. Try again.',
    )
  return { status: 'enabled', walletAddress: enabled.walletAddress }
}

/**
 * The wallet-wide emergency stop. Every payment checks this row inside its
 * reservation, so no client can start a payment after it returns.
 */
export async function disableSigner(
  database: D1Database,
  userId: string,
  now = Date.now(),
) {
  await drizzle(database)
    .update(paymentSigner)
    .set({ status: 'disabled', updatedAt: now })
    .where(eq(paymentSigner.privyUserId, userId))
  return signerStatus(database, userId)
}
