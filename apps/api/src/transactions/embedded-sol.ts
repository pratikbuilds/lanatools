import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { type } from 'arktype'
import { PrivyClient } from '@privy-io/node'
import { getBase64Encoder } from '@solana/kit'
import { EmbeddedTransferInput } from '@lanatools/contracts'
import type { TransactionResult } from '@lanatools/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { mcpGrant, transactionSigner } from '../db/schema'
import { activeGrantFor } from '../mcp-grants'
import type { GrantIdentity } from '../mcp-grants'
import type { SolanaEnv } from '../solana/network'
import {
  claimSigning,
  claimSubmission,
  createRequest,
  getLatestAttempt,
  getRequest,
  getRequestRecord,
  recordOutcome,
  storeVerifiedSigned,
  TransactionConflict,
} from './ledger'
import { prepareSolTransfer, readSolTransferIntent } from './prepare'
import type { PreparationReader } from './prepare'
import { validateSolTransferMessage } from './sol-transfer'
import {
  createSolExecutionRpc,
  unsignedSolWire,
  verifySignedSolTransfer,
} from './sol-execution'

export type EmbeddedSolEnv = SolanaEnv & {
  DB: D1Database
  PRIVY_APP_ID: string
  PRIVY_APP_SECRET: string
  PRIVY_PAYMENT_SIGNER_ID: string
  PRIVY_PAYMENT_SIGNER_KEY: string
  SOL_TRANSACTION_SIGNING_ENABLED?: string
  PRIVY_TRANSACTION_SIGNER_ID?: string
  PRIVY_TRANSACTION_SIGNER_KEY?: string
}
export type EmbeddedTransferResponse =
  { ok: true; result: TransactionResult } | { ok: false; reason: string }
export type EmbeddedSolDependencies = {
  prepare?: PreparationReader
  rpc?: typeof createSolExecutionRpc
  verify?: typeof verifySignedSolTransfer
  authority?: typeof resolveEmbeddedAuthority
}
const claimOf = (attempt: { id: string; claimToken: string }) => ({
  attemptId: attempt.id,
  token: attempt.claimToken,
})

function enabledConfiguration(env: EmbeddedSolEnv) {
  if (
    env.SOL_TRANSACTION_SIGNING_ENABLED !== 'true' ||
    env.SOLANA_NETWORK !== 'devnet' ||
    !env.SOLANA_RPC_URL ||
    !env.PRIVY_TRANSACTION_SIGNER_ID ||
    !env.PRIVY_TRANSACTION_SIGNER_KEY ||
    env.PRIVY_TRANSACTION_SIGNER_ID === env.PRIVY_PAYMENT_SIGNER_ID ||
    env.PRIVY_TRANSACTION_SIGNER_KEY === env.PRIVY_PAYMENT_SIGNER_KEY
  )
    throw new Error(
      'Automatic SOL signing is unavailable until separate transaction delegation is verified',
    )
}

/** No provisioning or owner attachment is exposed before the two-signer proof. */
export async function resolveEmbeddedAuthority(
  env: EmbeddedSolEnv,
  userId: string,
  client?: Pick<PrivyClient, 'wallets'>,
) {
  enabledConfiguration(env)
  const row = await drizzle(env.DB)
    .select()
    .from(transactionSigner)
    .where(
      and(
        eq(transactionSigner.privyUserId, userId),
        eq(transactionSigner.status, 'enabled'),
        eq(transactionSigner.signerId, env.PRIVY_TRANSACTION_SIGNER_ID!),
      ),
    )
    .get()
  if (!row)
    throw new Error(
      'Set up separate transaction delegation before automatic SOL transfers',
    )
  const privy =
    client ??
    new PrivyClient({
      appId: env.PRIVY_APP_ID,
      appSecret: env.PRIVY_APP_SECRET,
      maxRetries: 0,
      timeout: 10_000,
    })
  try {
    let owned = false
    for await (const wallet of privy
      .wallets()
      .list({ user_id: userId, chain_type: 'solana' }))
      if (wallet.id === row.walletId && wallet.address === row.walletAddress)
        owned = true
    if (!owned) throw new Error('Unavailable wallet')
    const wallet = await privy.wallets().get(row.walletId)
    if (
      wallet.address !== row.walletAddress ||
      !wallet.additional_signers.some(
        (signer) =>
          signer.signer_id === row.signerId &&
          signer.override_policy_ids?.length === 1 &&
          signer.override_policy_ids[0] === row.policyId,
      )
    )
      throw new Error('Unavailable signer')
  } catch {
    throw new Error('Could not verify separate transaction delegation')
  }
  return {
    walletId: row.walletId,
    walletAddress: row.walletAddress,
    signerId: row.signerId,
    sign: async (messageBase64: string) => {
      try {
        return (
          await privy
            .wallets()
            .solana()
            .signTransaction(row.walletId, {
              transaction: unsignedSolWire(messageBase64),
              authorization_context: {
                authorization_private_keys: [env.PRIVY_TRANSACTION_SIGNER_KEY!],
              },
            })
        ).signed_transaction
      } catch {
        throw new Error('Automatic transaction signing outcome is unknown')
      }
    },
  }
}

export async function executeEmbeddedSol(
  env: EmbeddedSolEnv,
  identity: GrantIdentity,
  raw: unknown,
  deps: EmbeddedSolDependencies = {},
): Promise<EmbeddedTransferResponse> {
  const input = EmbeddedTransferInput(raw)
  if (input instanceof type.errors)
    return { ok: false, reason: 'Invalid SOL transfer input' }
  const grant = await drizzle(env.DB)
    .select({ allowed: mcpGrant.outgoingAllowed })
    .from(mcpGrant)
    .where(activeGrantFor(identity))
    .get()
  if (!grant) return { ok: false, reason: 'MCP connection is unavailable' }
  if (!grant.allowed)
    return {
      ok: false,
      reason:
        'This client does not have permission for automatic SOL transfers',
    }
  let authority: Awaited<ReturnType<typeof resolveEmbeddedAuthority>>
  try {
    enabledConfiguration(env)
    authority = await (deps.authority ?? resolveEmbeddedAuthority)(
      env,
      identity.userId,
    )
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error
          ? error.message
          : 'Separate transaction delegation is unavailable',
    }
  }
  // The configured ID still governs mock and real authority resolution.
  if (authority.signerId !== env.PRIVY_TRANSACTION_SIGNER_ID)
    return {
      ok: false,
      reason: 'Separate transaction delegation is unavailable',
    }
  const request = await createRequest(
    env.DB,
    identity,
    { action: 'transfer_sol', execution: 'embedded', ...input },
    {
      network: 'devnet',
      embeddedWallet: {
        id: authority.walletId,
        address: authority.walletAddress,
      },
    },
  )
  await prepareSolTransfer(
    env.DB,
    identity,
    request.requestId,
    env,
    deps.prepare,
  )
  let attempt = await getLatestAttempt(env.DB, identity, request.requestId)
  if (attempt?.state === 'prepared' && attempt.messageBase64) {
    const rpc = await (deps.rpc ?? createSolExecutionRpc)(env)
    if (
      !attempt.lastValidBlockHeight ||
      (await rpc.blockHeight()) > BigInt(attempt.lastValidBlockHeight)
    )
      return {
        ok: false,
        reason: 'Prepared transfer has expired; no new signature was requested',
      }
    let signing
    try {
      signing = await claimSigning(
        env.DB,
        identity,
        claimOf(attempt),
        authority.signerId,
      )
    } catch (error) {
      if (error instanceof TransactionConflict)
        return {
          ok: true,
          result: await getRequest(env.DB, identity, request.requestId),
        }
      throw error
    }
    try {
      if (!signing.messageBase64) throw new Error('Missing message')
      const record = await getRequestRecord(env.DB, identity, request.requestId)
      const intent = readSolTransferIntent(record.canonicalInput)
      const transfer = expected(attempt, intent)
      validateSolTransferMessage(
        new Uint8Array(getBase64Encoder().encode(signing.messageBase64)),
        transfer,
      )
      const bytes = await authority.sign(signing.messageBase64)
      const verified = await (deps.verify ?? verifySignedSolTransfer)(
        bytes,
        transfer,
      )
      await storeVerifiedSigned(env.DB, identity, signing, verified)
    } catch {
      // A sign-only call may have produced a signature despite a lost response.
      try {
        await recordOutcome(env.DB, identity, signing, {
          kind: 'transport_unknown',
          reason:
            'Signing outcome is unknown; no replacement or additional signing call will be made',
        })
      } catch {
        /* A revoked grant also prevents new writes. */
      }
      return {
        ok: true,
        result: await getRequest(env.DB, identity, request.requestId),
      }
    }
    attempt = await getLatestAttempt(env.DB, identity, request.requestId)
  }
  if (attempt?.state === 'signed' && attempt.signedBase64) {
    const rpc = await (deps.rpc ?? createSolExecutionRpc)(env)
    if (
      !attempt.lastValidBlockHeight ||
      (await rpc.blockHeight()) > BigInt(attempt.lastValidBlockHeight)
    )
      return {
        ok: true,
        result: await getRequest(env.DB, identity, request.requestId),
      }
    let submission
    try {
      submission = await claimSubmission(env.DB, identity, claimOf(attempt))
    } catch (error) {
      if (error instanceof TransactionConflict)
        return {
          ok: true,
          result: await getRequest(env.DB, identity, request.requestId),
        }
      throw error
    }
    try {
      const signature = await rpc.send(attempt.signedBase64)
      if (signature !== attempt.signature)
        throw new Error('RPC signature mismatch')
      await recordOutcome(env.DB, identity, submission, {
        kind: 'rpc_accepted',
        signature,
      })
    } catch {
      try {
        await recordOutcome(env.DB, identity, submission, {
          kind: 'transport_unknown',
          reason:
            'Submission outcome is unknown; check status before any further action',
        })
      } catch {
        /* Preserve the durable claim if revocation prevents writes. */
      }
    }
  }
  return {
    ok: true,
    result: await getTransferStatus(env, identity, request.requestId, deps),
  }
}

function expected(
  attempt: {
    walletAddress: string
    blockhash: string | null
    lastValidBlockHeight: string | null
  },
  intent: { recipient: string; amountLamports: string },
) {
  if (!attempt.blockhash || !attempt.lastValidBlockHeight)
    throw new Error('Unprepared transaction')
  return {
    walletAddress: attempt.walletAddress,
    recipient: intent.recipient,
    amountLamports: intent.amountLamports,
    blockhash: attempt.blockhash,
    lastValidBlockHeight: BigInt(attempt.lastValidBlockHeight),
  }
}

/** Current owner/client identity remains required even after permission disable. */
export async function getTransferStatus(
  env: EmbeddedSolEnv,
  identity: GrantIdentity,
  requestId: string,
  deps: EmbeddedSolDependencies = {},
): Promise<TransactionResult> {
  const request = await getRequestRecord(env.DB, identity, requestId)
  const attempt = await getLatestAttempt(env.DB, identity, requestId)
  if (
    request.network === 'devnet' &&
    attempt?.signedBase64 &&
    attempt.signature &&
    [
      'signed',
      'submitting',
      'submitted',
      'uncertain',
      'succeeded',
      'failed',
    ].includes(attempt.state)
  ) {
    try {
      const rpc = await (deps.rpc ?? createSolExecutionRpc)(env)
      const evidence = await rpc.status(attempt.signature)
      if (evidence) {
        const verified = await (deps.verify ?? verifySignedSolTransfer)(
          evidence.signedBase64,
          expected(attempt, readSolTransferIntent(request.canonicalInput)),
        )
        if (
          verified.signedBase64 !== attempt.signedBase64 ||
          verified.signature !== attempt.signature
        )
          throw new Error('Chain bytes mismatch')
        await recordOutcome(env.DB, identity, claimOf(attempt), {
          kind: evidence.failed ? 'chain_failure' : 'chain_success',
          signature: verified.signature,
          slot: evidence.slot,
          commitment: evidence.commitment,
          reason: evidence.failed ? 'Transaction failed on devnet' : null,
        })
      }
    } catch {
      /* Incomplete chain evidence leaves the prior state unchanged. */
    }
  }
  return getRequest(env.DB, identity, requestId)
}
