import { and, eq, inArray, isNull } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type {
  PaymentSignerGrant,
  PaymentSignerStatus,
} from '@lanatools/contracts'
import type { PrivyClient } from '@privy-io/node'
import { paymentSigner } from '../db/schema'
import type { PaymentNetwork } from '../solana/network'
import { transactionPrograms } from '../transactions/tools'

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

export class SignerSetupError extends Error {
  override readonly name = 'SignerSetupError'
}

/** Privy does not show the signer on the wallet with the current policy. */
export class SignerNotAttachedError extends SignerSetupError {}

/** Whether a stored policy allows USDC transfers on the configured network. */
async function policyAllowsMint(
  privy: PrivyClient,
  policyId: string,
  usdcMint: string,
) {
  const policy = await privy.policies().get(policyId)
  return policy.rules.some((rule) =>
    rule.conditions.some(
      (condition) =>
        'field' in condition &&
        condition.field === 'TransferChecked.mint' &&
        condition.value === usdcMint,
    ),
  )
}

/** Whether a stored transaction policy allows exactly the current programs. */
async function policyAllowsPrograms(
  privy: PrivyClient,
  policyId: string,
  programs: readonly string[],
) {
  const policy = await privy.policies().get(policyId)
  return (
    policy.rules.some(
      (rule) =>
        rule.method === 'signMessage' &&
        rule.action === 'ALLOW' &&
        rule.conditions.some(
          (condition) =>
            'field_source' in condition &&
            condition.field_source === 'message' &&
            condition.field === 'content' &&
            condition.operator === 'starts_with' &&
            condition.value === 'phoenix-wallet-login-v1\n',
        ),
    ) &&
    policy.rules.some((rule) =>
      rule.conditions.some(
        (condition) =>
          'field' in condition &&
          condition.field === 'programId' &&
          Array.isArray(condition.value) &&
          condition.value.length === programs.length &&
          programs.every((program) => condition.value.includes(program)),
      ),
    )
  )
}

/**
 * The transaction signer's policy: the programs LanaTools transaction tools
 * call, and nothing else. It has no amount or address rules. Swaps load
 * accounts from lookup tables, which Privy cannot read, while program IDs
 * are always in a transaction's static keys.
 */
function createTransactionPolicy(privy: PrivyClient, userId: string) {
  return privy.policies().create({
    name: 'LanaTools agent transactions',
    version: '1.0',
    chain_type: 'solana',
    owner: { user_id: userId },
    rules: [
      {
        name: 'Allow Phoenix wallet login',
        method: 'signMessage',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'message',
            field: 'content',
            operator: 'starts_with',
            value: 'phoenix-wallet-login-v1\n',
          },
        ],
      },
      {
        name: 'Allow LanaTools transaction programs',
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_program_instruction',
            field: 'programId',
            operator: 'in',
            value: transactionPrograms(),
          },
        ],
      },
    ],
  })
}

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

/**
 * The saved setup. With a transaction signer configured, a setup made before
 * it existed reads as pending, so the dashboard sets it up again.
 */
export async function signerStatus(
  database: D1Database,
  userId: string,
  transactionSigner = false,
  privy?: PrivyClient,
): Promise<PaymentSignerStatus> {
  const row = await drizzle(database)
    .select()
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, userId))
    .get()
  if (!row) return { status: 'none', walletAddress: null }
  const outdated =
    transactionSigner &&
    row.status === 'enabled' &&
    (!row.transactionPolicyId ||
      (privy !== undefined &&
        !(await policyAllowsPrograms(
          privy,
          row.transactionPolicyId,
          transactionPrograms(),
        ))))
  return {
    status: outdated ? 'pending' : row.status,
    walletAddress: row.walletAddress,
  }
}

/**
 * Prepares the LanaTools server signers for the user's embedded wallet: finds
 * the wallet among the user's own Privy wallets and creates user-owned
 * policies. The payment signer may sign only USDC transfers plus Compute
 * Budget and Memo instructions; how much may be paid is enforced by each
 * client's limit in D1, not by this policy. The transaction signer, when the
 * deployment has one, may sign only the programs LanaTools transaction tools
 * call. The browser then adds the signers with Privy, as only the wallet's
 * owner can.
 */
export async function prepareSigner(
  database: D1Database,
  privy: PrivyClient,
  {
    userId,
    walletAddress,
    signerId,
    transactionSignerId,
    network,
    restore,
  }: {
    userId: string
    walletAddress: string
    signerId: string
    /** The transaction signer's key quorum; absent when not configured. */
    transactionSignerId?: string | undefined
    network: PaymentNetwork
    /** The user asked to set up again after removing LanaTools access. */
    restore: boolean
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
  // Access the user removed comes back only when they ask, so the automatic
  // setup in a stale tab cannot undo a removal.
  if (existing?.status === 'disabled' && !restore)
    throw new SignerSetupError(
      'You removed LanaTools access. Set it up again in Settings.',
    )
  // Setup for the same wallet keeps its policies, whether it is unfinished,
  // already on (say, from another tab), or set up again after a removal. A
  // signer left on the wallet then still matches, so setup can always finish.
  // A policy for another network's USDC, or for programs the transaction
  // tools no longer match, is replaced instead.
  const sameWallet = existing?.walletId === walletId
  const paymentPolicyId =
    existing &&
    sameWallet &&
    (await policyAllowsMint(privy, existing.policyId, network.usdcMint))
      ? existing.policyId
      : (await createPaymentPolicy(privy, userId, network)).id
  const transactionPolicyId = !transactionSignerId
    ? null
    : existing?.transactionPolicyId &&
        sameWallet &&
        (await policyAllowsPrograms(
          privy,
          existing.transactionPolicyId,
          transactionPrograms(),
        ))
      ? existing.transactionPolicyId
      : (await createTransactionPolicy(privy, userId)).id
  const grant: PaymentSignerGrant = {
    signers: [
      { signerId, policyIds: [paymentPolicyId] },
      ...(transactionSignerId && transactionPolicyId
        ? [{ signerId: transactionSignerId, policyIds: [transactionPolicyId] }]
        : []),
    ],
  }
  if (
    existing &&
    existing.policyId === paymentPolicyId &&
    existing.transactionPolicyId === transactionPolicyId
  ) {
    if (existing.status === 'disabled')
      await db
        .update(paymentSigner)
        .set({ status: 'pending', updatedAt: now })
        .where(
          and(
            eq(paymentSigner.privyUserId, userId),
            eq(paymentSigner.status, 'disabled'),
          ),
        )
    return grant
  }

  const row = {
    walletId,
    walletAddress,
    policyId: paymentPolicyId,
    transactionPolicyId,
    status: 'pending' as const,
    updatedAt: now,
  }
  // Only the row read above is replaced: a removal or another setup during
  // the Privy calls wins, so a stale tab cannot undo it.
  const saved = existing
    ? await db
        .update(paymentSigner)
        .set(row)
        .where(
          and(
            eq(paymentSigner.privyUserId, userId),
            eq(paymentSigner.policyId, existing.policyId),
            eq(paymentSigner.status, existing.status),
          ),
        )
        .returning({ userId: paymentSigner.privyUserId })
    : await db
        .insert(paymentSigner)
        .values({ privyUserId: userId, ...row })
        .onConflictDoNothing()
        .returning({ userId: paymentSigner.privyUserId })
  if (saved.length === 0)
    throw new SignerSetupError(
      'LanaTools access was removed or set up again meanwhile. Try again.',
    )
  return grant
}

/** The payment signer's policy: USDC transfers, Compute Budget and Memo. */
function createPaymentPolicy(
  privy: PrivyClient,
  userId: string,
  network: PaymentNetwork,
) {
  return privy.policies().create({
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
}

/**
 * Turns payments on once Privy reports each server signer on the wallet with
 * exactly its LanaTools policy. The browser's word is not enough.
 */
export async function confirmSigner(
  database: D1Database,
  privy: PrivyClient,
  userId: string,
  signerId: string,
  transactionSignerId?: string,
  now = Date.now(),
): Promise<PaymentSignerStatus> {
  const db = drizzle(database)
  const row = await db
    .select()
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, userId))
    .get()
  if (!row) throw new SignerSetupError('Set up payments first')
  if (row.status === 'disabled')
    throw new SignerSetupError(
      'You removed LanaTools access. Set it up again in Settings.',
    )
  const wallet = await privy.wallets().get(row.walletId)
  const has = (id: string, policyId: string) =>
    wallet.additional_signers.some(
      (signer) =>
        signer.signer_id === id &&
        signer.override_policy_ids?.length === 1 &&
        signer.override_policy_ids[0] === policyId,
    )
  const attached =
    has(signerId, row.policyId) &&
    (!transactionSignerId ||
      (row.transactionPolicyId !== null &&
        has(transactionSignerId, row.transactionPolicyId)))
  if (!attached)
    throw new SignerNotAttachedError(
      'Privy does not show the LanaTools signer on this wallet yet',
    )
  // Only the setup that was checked can be enabled: a removal or a new setup
  // since the read above wins.
  const [enabled] = await db
    .update(paymentSigner)
    .set({ status: 'enabled', updatedAt: now })
    .where(
      and(
        eq(paymentSigner.privyUserId, userId),
        eq(paymentSigner.policyId, row.policyId),
        row.transactionPolicyId === null
          ? isNull(paymentSigner.transactionPolicyId)
          : eq(paymentSigner.transactionPolicyId, row.transactionPolicyId),
        inArray(paymentSigner.status, ['pending', 'enabled']),
      ),
    )
    .returning({ walletAddress: paymentSigner.walletAddress })
  if (!enabled)
    throw new SignerSetupError(
      'LanaTools access was removed or set up again meanwhile. Try again.',
    )
  return { status: 'enabled', walletAddress: enabled.walletAddress }
}

/**
 * Removes LanaTools access, the user's wallet-wide stop. Every payment checks
 * this row inside its reservation, so no client can start a payment after it
 * returns. The dashboard then removes the signer from the wallet.
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
