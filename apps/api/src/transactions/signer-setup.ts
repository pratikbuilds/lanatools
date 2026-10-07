import { and, eq, inArray, sql } from 'drizzle-orm'
import { type } from 'arktype'
import { drizzle } from 'drizzle-orm/d1'
import { isAddress } from '@solana/kit'
import type { PrivyClient } from '@privy-io/node'
import type {
  TransactionSignerGrant,
  TransactionSignerStatus,
} from '@lanatools/contracts'
import { transactionSigner, walletSignerRemoval } from '../db/schema'
import { SignerSetupError } from '../payments/signer-setup'
import {
  ownedWallet,
  removeOwnedSigner,
  assertNoSignerRemoval,
} from '../payments/selective-signer'
import type { SignerWalletClient } from '../payments/selective-signer'
import { enabledConfiguration } from './embedded-sol'
import type { EmbeddedSolEnv } from './embedded-sol'

type ConfirmedPolicy = Pick<
  Awaited<ReturnType<ReturnType<PrivyClient['policies']>['get']>>,
  'id' | 'chain_type' | 'version' | 'owner_id' | 'rules'
>

export interface TransactionSignerClient extends SignerWalletClient {
  keyQuorums: () => {
    get: (
      quorumId: string,
    ) => Promise<
      Pick<
        Awaited<ReturnType<ReturnType<PrivyClient['keyQuorums']>['get']>>,
        | 'id'
        | 'user_ids'
        | 'authorization_keys'
        | 'authorization_threshold'
        | 'key_quorum_ids'
      >
    >
  }
  policies: () => {
    get: (policyId: string) => Promise<ConfirmedPolicy>
    create: (
      input: Parameters<ReturnType<PrivyClient['policies']>['create']>[0],
    ) => Promise<{ id: string }>
  }
}
const PREPARING = 'preparing:'

function available(env: EmbeddedSolEnv) {
  try {
    enabledConfiguration(env)
    return true
  } catch {
    return false
  }
}
function configuration(env: EmbeddedSolEnv) {
  try {
    enabledConfiguration(env)
  } catch {
    throw new SignerSetupError(
      'Automatic SOL setup is unavailable until separate transaction delegation is verified',
    )
  }
  if (!env.PRIVY_TRANSACTION_SIGNER_ID)
    throw new SignerSetupError('Transaction signer is unavailable')
  return env.PRIVY_TRANSACTION_SIGNER_ID
}

export async function signerStatus(
  env: EmbeddedSolEnv,
  userId: string,
): Promise<TransactionSignerStatus> {
  const row = await drizzle(env.DB)
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, userId))
    .get()
  return {
    status: row?.status ?? 'none',
    walletAddress: row?.walletAddress ?? null,
    setupAvailable: available(env),
  }
}

/** Creates a user-owned policy; only the owner browser may attach the signer. */
export async function prepareSigner(
  env: EmbeddedSolEnv,
  privy: TransactionSignerClient,
  { userId, walletAddress }: { userId: string; walletAddress: string },
  now = Date.now(),
): Promise<TransactionSignerGrant> {
  const signerId = configuration(env)
  if (!isAddress(walletAddress))
    throw new SignerSetupError('Invalid embedded wallet address')
  try {
    const matches = []
    for await (const wallet of privy
      .wallets()
      .list({ user_id: userId, chain_type: 'solana' }))
      if (wallet.address === walletAddress) matches.push(wallet)
    const wallet = matches[0]
    if (matches.length !== 1 || !wallet)
      throw new SignerSetupError('That wallet is not your embedded wallet')
    await assertNoSignerRemoval(env.DB, wallet.id)
    const currentWallet = await ownedWallet(
      privy,
      userId,
      wallet.id,
      walletAddress,
    )
    const db = drizzle(env.DB)
    const existing = await db
      .select()
      .from(transactionSigner)
      .where(eq(transactionSigner.privyUserId, userId))
      .get()
    if (existing && existing.walletId !== wallet.id)
      await assertNoSignerRemoval(env.DB, existing.walletId)
    if (existing && existing.status !== 'disabled') {
      if (
        existing.walletId !== wallet.id ||
        existing.walletAddress !== walletAddress ||
        existing.signerId !== signerId
      )
        throw new SignerSetupError(
          'Disable the previous transaction setup before preparing another wallet or signer',
        )
      if (existing.policyId.startsWith(PREPARING))
        throw new SignerSetupError(
          'Transaction setup is in progress or its outcome is unknown. Disable it before retrying.',
        )
      return { signerId, policyIds: [existing.policyId] }
    }
    if (existing) {
      if (
        !existing.policyId.startsWith(PREPARING) &&
        (existing.walletId !== wallet.id ||
          existing.walletAddress !== walletAddress ||
          existing.signerId !== signerId)
      )
        throw new SignerSetupError(
          'The previous transaction setup may still have an owner attachment in flight. Review it before changing wallets or signers.',
        )
      const previousWallet =
        existing.walletId === wallet.id &&
        existing.walletAddress === walletAddress
          ? currentWallet
          : await ownedWallet(
              privy,
              userId,
              existing.walletId,
              existing.walletAddress,
            )
      if (
        previousWallet.additional_signers.some(
          (signer) => signer.signer_id === existing.signerId,
        )
      )
        throw new SignerSetupError(
          'Remove the remaining transaction signer before enabling a new setup. Retry removal first.',
        )
    }
    const claim = PREPARING + crypto.randomUUID()
    // A canceled owner addSigners call can still finish. Keep its policy bound.
    const policyId =
      existing && !existing.policyId.startsWith(PREPARING)
        ? existing.policyId
        : claim
    const pending = {
      walletId: wallet.id,
      walletAddress,
      signerId,
      policyId,
      status: 'pending' as const,
      updatedAt: now,
    }
    const [claimed] = await db
      .insert(transactionSigner)
      .values({ privyUserId: userId, ...pending })
      .onConflictDoUpdate({
        target: transactionSigner.privyUserId,
        set: pending,
        setWhere: existing
          ? sql`
          ${transactionSigner.status} = 'disabled'
          and ${transactionSigner.walletId} = ${existing.walletId}
          and ${transactionSigner.walletAddress} = ${existing.walletAddress}
          and ${transactionSigner.signerId} = ${existing.signerId}
          and ${transactionSigner.policyId} = ${existing.policyId}
          and not exists (select 1 from ${walletSignerRemoval}
            where ${walletSignerRemoval.walletId} in (${existing.walletId}, ${wallet.id}))
        `
          : sql`0`,
      })
      .returning()
    if (!claimed)
      throw new SignerSetupError(
        'Transaction setup changed. Refresh and try again.',
      )
    if (policyId !== claim) return { signerId, policyIds: [policyId] }
    const policy = await privy.policies().create({
      name: 'LanaTools automatic SOL transfers',
      version: '1.0',
      chain_type: 'solana',
      owner: { user_id: userId },
      rules: [
        {
          name: 'Allow native SOL System Transfer only',
          method: 'signTransaction',
          action: 'ALLOW',
          conditions: [
            {
              field_source: 'solana_system_program_instruction',
              field: 'instructionName',
              operator: 'eq',
              value: 'Transfer',
            },
          ],
        },
      ],
    })
    if (!policy.id || policy.id.startsWith(PREPARING))
      throw new SignerSetupError(
        'Transaction policy creation could not be verified',
      )
    const [prepared] = await db
      .update(transactionSigner)
      .set({ policyId: policy.id, updatedAt: Date.now() })
      .where(
        and(
          eq(transactionSigner.privyUserId, userId),
          eq(transactionSigner.policyId, claim),
          eq(transactionSigner.status, 'pending'),
          eq(transactionSigner.walletId, wallet.id),
          eq(transactionSigner.walletAddress, walletAddress),
          eq(transactionSigner.signerId, signerId),
          sql`not exists (select 1 from ${walletSignerRemoval} where ${walletSignerRemoval.walletId} = ${wallet.id})`,
        ),
      )
      .returning()
    if (!prepared)
      throw new SignerSetupError(
        'Transaction setup was disabled or replaced meanwhile. Refresh before continuing.',
      )
    return { signerId, policyIds: [policy.id] }
  } catch (error) {
    if (error instanceof SignerSetupError) throw error
    throw new SignerSetupError(
      'Transaction setup could not be completed. Refresh; disable pending setup before retrying.',
    )
  }
}

export async function confirmSigner(
  env: EmbeddedSolEnv,
  privy: TransactionSignerClient,
  { userId, walletAddress }: { userId: string; walletAddress: string },
  now = Date.now(),
): Promise<TransactionSignerStatus> {
  const signerId = configuration(env)
  const db = drizzle(env.DB)
  const row = await db
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, userId))
    .get()
  if (
    !row ||
    row.walletAddress !== walletAddress ||
    row.signerId !== signerId ||
    row.policyId.startsWith(PREPARING) ||
    row.status === 'disabled'
  )
    throw new SignerSetupError(
      'Prepare transaction setup for your current embedded wallet first',
    )
  try {
    await assertNoSignerRemoval(env.DB, row.walletId)
    const wallet = await ownedWallet(privy, userId, row.walletId, walletAddress)
    const policy = await privy.policies().get(row.policyId)
    type("'1.0'").assert(policy.version)
    const rule = policy.rules[0]
    const condition = rule?.conditions[0]
    if (
      policy.id !== row.policyId ||
      policy.chain_type !== 'solana' ||
      !policy.owner_id ||
      policy.rules.length !== 1 ||
      rule?.method !== 'signTransaction' ||
      rule.action !== 'ALLOW' ||
      rule.conditions.length !== 1 ||
      condition?.field_source !== 'solana_system_program_instruction' ||
      condition.field !== 'instructionName' ||
      condition.operator !== 'eq' ||
      condition.value !== 'Transfer'
    )
      throw new SignerSetupError(
        'Transaction policy no longer allows only native SOL transfers. Disable it and prepare again.',
      )

    const owner = await privy.keyQuorums().get(policy.owner_id)
    if (
      owner.id !== policy.owner_id ||
      owner.user_ids?.length !== 1 ||
      owner.user_ids[0] !== userId ||
      owner.authorization_keys.length !== 0 ||
      (owner.key_quorum_ids?.length ?? 0) !== 0 ||
      owner.authorization_threshold !== 1
    )
      throw new SignerSetupError(
        'Transaction policy must be owned only by your Privy user',
      )
    const signers = wallet.additional_signers.filter(
      (signer) => signer.signer_id === signerId,
    )
    if (
      signers.length !== 1 ||
      signers[0]?.override_policy_ids?.length !== 1 ||
      signers[0].override_policy_ids[0] !== row.policyId
    )
      throw new SignerSetupError(
        'Privy does not show the dedicated transaction signer with exactly this policy',
      )
    const [enabled] = await db
      .update(transactionSigner)
      .set({ status: 'enabled', updatedAt: now })
      .where(
        and(
          eq(transactionSigner.privyUserId, userId),
          eq(transactionSigner.walletId, row.walletId),
          eq(transactionSigner.walletAddress, row.walletAddress),
          eq(transactionSigner.signerId, signerId),
          eq(transactionSigner.policyId, row.policyId),
          inArray(transactionSigner.status, ['pending', 'enabled']),
          sql`not exists (select 1 from ${walletSignerRemoval} where ${walletSignerRemoval.walletId} = ${row.walletId})`,
        ),
      )
      .returning()
    if (!enabled)
      throw new SignerSetupError(
        'Transaction setup was disabled or replaced meanwhile. Refresh and try again.',
      )
    return {
      status: 'enabled',
      walletAddress: enabled.walletAddress,
      setupAvailable: true,
    }
  } catch (error) {
    if (error instanceof SignerSetupError) throw error
    throw new SignerSetupError(
      'Could not verify transaction delegation. Refresh and try again.',
    )
  }
}

/** Stop local claims first, even if provider removal fails or setup is unavailable. */
export async function disableSigner(
  env: EmbeddedSolEnv,
  privy: SignerWalletClient,
  input: { userId: string; walletAddress: string; userAccessToken: string },
  now = Date.now(),
): Promise<TransactionSignerStatus> {
  const [stopped] = await drizzle(env.DB)
    .update(transactionSigner)
    .set({ status: 'disabled', updatedAt: now })
    .where(eq(transactionSigner.privyUserId, input.userId))
    .returning()
  if (!stopped) return signerStatus(env, input.userId)
  if (stopped.walletAddress !== input.walletAddress)
    throw new SignerSetupError(
      'Automatic SOL is off, but your embedded wallet changed. Refresh before removing its signer.',
    )
  await removeOwnedSigner(env.DB, privy, {
    ...input,
    walletId: stopped.walletId,
    signerId: stopped.signerId,
    policyId: stopped.policyId,
  })
  return signerStatus(env, input.userId)
}
