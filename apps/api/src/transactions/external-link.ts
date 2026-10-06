import { and, eq, gt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { type } from 'arktype'
import { isAddress } from '@solana/kit'
import { ExternalTransferInput } from '@lanatools/contracts'
import type {
  ExternalTransferLink,
  ExternalTransferReview,
} from '@lanatools/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { mcpGrant, transactionLink, transactionRequest } from '../db/schema'
import { activeGrantFor } from '../mcp-grants'
import type { GrantIdentity } from '../mcp-grants'
import type { SolanaEnv } from '../solana/network'
import { hashBytes } from './input'
import {
  claimSubmission,
  createRequest,
  getLatestAttempt,
  getRequestRecord,
  issueAttempt,
  recordOutcome,
  selectExternalWallet,
  storeVerifiedSigned,
  TransactionConflict,
} from './ledger'
import { prepareSolTransfer, readSolTransferIntent } from './prepare'
import type { PreparationReader } from './prepare'
import {
  createSolExecutionRpc,
  unsignedSolWire,
  verifySignedSolTransfer,
} from './sol-execution'

export type ExternalLinkEnv = SolanaEnv & {
  DB: D1Database
  SIGNING_LINK_ORIGIN?: string
  SIGNING_LINK_TTL_SECONDS?: string
}
export class ExternalLinkError extends Error {
  constructor(
    readonly status: 400 | 403 | 409 | 502 | 503,
    message: string,
  ) {
    super(message)
  }
}
export type ExternalLinkDependencies = {
  prepare?: PreparationReader
  rpc?: typeof createSolExecutionRpc
  verify?: typeof verifySignedSolTransfer
}
const claimOf = (attempt: { id: string; claimToken: string }) => ({
  attemptId: attempt.id,
  token: attempt.claimToken,
})

function devnet(env: ExternalLinkEnv) {
  if (env.SOLANA_NETWORK !== 'devnet' || !env.SOLANA_RPC_URL)
    throw new ExternalLinkError(
      503,
      'SOL transfers require configured devnet RPC',
    )
}

export async function createExternalLink(
  env: ExternalLinkEnv,
  identity: GrantIdentity,
  raw: unknown,
  now = Date.now(),
): Promise<ExternalTransferLink> {
  devnet(env)
  const input = ExternalTransferInput(raw)
  if (
    input instanceof type.errors ||
    !isAddress(input.recipient) ||
    (input.externalWallet !== null && !isAddress(input.externalWallet))
  )
    throw new ExternalLinkError(400, 'Invalid SOL transfer input')
  const origin = new URL(env.SIGNING_LINK_ORIGIN ?? 'https://lanatools.sh')
  if (
    origin.protocol !== 'https:' &&
    !(
      origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(origin.hostname)
    )
  )
    throw new ExternalLinkError(503, 'Signing link origin is unavailable')
  const request = await createRequest(
    env.DB,
    identity,
    { action: 'transfer_sol', execution: 'external', ...input },
    { network: 'devnet', embeddedWallet: null },
    now,
  )
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
  const tokenHash = await hashBytes(new TextEncoder().encode(token))
  const ttl = env.SIGNING_LINK_TTL_SECONDS ?? '900'
  if (!/^[1-9]\d{0,4}$/.test(ttl) || Number(ttl) > 86_400)
    throw new ExternalLinkError(503, 'Signing link lifetime is unavailable')
  const expiresAt = now + Number(ttl) * 1000
  const row = await drizzle(env.DB).get<{ token_hash: string } | undefined>(sql`
    insert into transaction_link (token_hash, request_id, grant_id, expires_at, created_at)
    select ${tokenHash}, ${request.requestId}, ${mcpGrant.id}, ${expiresAt}, ${now}
    from ${mcpGrant} where ${activeGrantFor(identity)} returning token_hash
  `)
  if (!row) throw new ExternalLinkError(403, 'Transfer link is unavailable')
  const link = new URL('/sign', origin.origin)
  link.hash = new URLSearchParams({ token }).toString()
  return {
    requestId: request.requestId,
    signingUrl: link.toString(),
    expiresAt,
  }
}

async function resolve(env: ExternalLinkEnv, token: string, now = Date.now()) {
  devnet(env)
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new ExternalLinkError(403, 'Transfer link is unavailable or expired')
  const tokenHash = await hashBytes(new TextEncoder().encode(token))
  const row = await drizzle(env.DB)
    .select({
      requestId: transactionRequest.id,
      userId: mcpGrant.privyUserId,
      clientId: mcpGrant.clientId,
      grantId: mcpGrant.id,
      expiresAt: transactionLink.expiresAt,
    })
    .from(transactionLink)
    .innerJoin(
      transactionRequest,
      eq(transactionRequest.id, transactionLink.requestId),
    )
    .innerJoin(
      mcpGrant,
      and(
        eq(mcpGrant.id, transactionLink.grantId),
        eq(mcpGrant.privyUserId, transactionRequest.privyUserId),
        eq(mcpGrant.clientId, transactionRequest.clientId),
      ),
    )
    .where(
      and(
        eq(transactionLink.tokenHash, tokenHash),
        gt(transactionLink.expiresAt, now),
        eq(mcpGrant.status, 'active'),
        eq(transactionRequest.execution, 'external'),
        eq(transactionRequest.network, 'devnet'),
      ),
    )
    .get()
  if (!row)
    throw new ExternalLinkError(403, 'Transfer link is unavailable or expired')
  const identity: GrantIdentity = {
    userId: row.userId,
    clientId: row.clientId,
    grantId: row.grantId,
  }
  const request = await getRequestRecord(env.DB, identity, row.requestId)
  const intent = readSolTransferIntent(request.canonicalInput)
  if (intent.execution !== 'external' || intent.network !== 'devnet')
    throw new ExternalLinkError(403, 'Transfer link is unavailable')
  return { identity, request, intent, expiresAt: row.expiresAt }
}

export async function reviewExternalLink(
  env: ExternalLinkEnv,
  token: string,
  deps: ExternalLinkDependencies = {},
): Promise<ExternalTransferReview> {
  const { identity, request, intent, expiresAt } = await resolve(env, token)
  let attempt = await getLatestAttempt(env.DB, identity, request.id)
  let transactionExpired = false
  let heightKnown = false
  if (attempt?.lastValidBlockHeight) {
    try {
      const rpc = await (deps.rpc ?? createSolExecutionRpc)(env)
      transactionExpired =
        (await rpc.blockHeight()) > BigInt(attempt.lastValidBlockHeight)
      heightKnown = true
      if (
        attempt.signature &&
        attempt.signedBase64 &&
        [
          'signed',
          'submitting',
          'submitted',
          'uncertain',
          'succeeded',
          'failed',
        ].includes(attempt.state)
      ) {
        const evidence = await rpc.status(attempt.signature)
        if (evidence) {
          const verified = await (deps.verify ?? verifySignedSolTransfer)(
            evidence.signedBase64,
            expected(attempt, intent),
          )
          if (
            verified.signature !== attempt.signature ||
            verified.signedBase64 !== attempt.signedBase64
          )
            throw new Error('Chain transaction mismatch')
          await resolve(env, token)
          await recordOutcome(env.DB, identity, claimOf(attempt), {
            kind: evidence.failed ? 'chain_failure' : 'chain_success',
            signature: verified.signature,
            slot: evidence.slot,
            commitment: evidence.commitment,
            reason: evidence.failed ? 'Transaction failed on devnet' : null,
          })
          attempt = await getLatestAttempt(env.DB, identity, request.id)
        }
      }
    } catch {
      // Absence, transport errors and incomplete evidence never imply failure.
    }
  }
  await resolve(env, token)
  const Evidence = type({
    commitment: "'confirmed' | 'finalized'",
    '+': 'ignore',
  })
  const evidence = attempt?.evidence
    ? Evidence(JSON.parse(attempt.evidence))
    : null
  return {
    requestId: request.id,
    state:
      request.status === 'refused'
        ? 'refused'
        : (attempt?.state ?? 'requested'),
    recipient: intent.recipient,
    amountLamports: intent.amountLamports,
    walletAddress: request.walletAddress,
    network: 'devnet',
    expiresAt,
    transactionBase64:
      attempt?.state === 'issued' &&
      heightKnown &&
      !transactionExpired &&
      attempt.messageBase64
        ? unsignedSolWire(attempt.messageBase64)
        : null,
    signature: attempt?.signature ?? null,
    reason:
      request.refusal ??
      (attempt?.state === 'failed' ? 'Transaction failed on devnet' : null),
    commitment:
      evidence && !(evidence instanceof type.errors)
        ? evidence.commitment
        : null,
    transactionExpired,
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
    throw new ExternalLinkError(409, 'Transaction is not prepared')
  return {
    walletAddress: attempt.walletAddress,
    recipient: intent.recipient,
    amountLamports: intent.amountLamports,
    blockhash: attempt.blockhash,
    lastValidBlockHeight: BigInt(attempt.lastValidBlockHeight),
  }
}

export async function prepareExternalLink(
  env: ExternalLinkEnv,
  token: string,
  walletAddress: string,
  deps: ExternalLinkDependencies = {},
) {
  const { identity, request } = await resolve(env, token)
  if (!isAddress(walletAddress))
    throw new ExternalLinkError(400, 'Invalid external wallet')
  await selectExternalWallet(env.DB, identity, request.id, walletAddress)
  await prepareSolTransfer(env.DB, identity, request.id, env, deps.prepare)
  const attempt = await getLatestAttempt(env.DB, identity, request.id)
  if (attempt?.state === 'prepared') {
    const rpc = await (deps.rpc ?? createSolExecutionRpc)(env)
    if (
      !attempt.lastValidBlockHeight ||
      (await rpc.blockHeight()) > BigInt(attempt.lastValidBlockHeight)
    )
      throw new ExternalLinkError(409, 'Transaction lifetime has expired')
    await resolve(env, token)
    try {
      await issueAttempt(env.DB, identity, claimOf(attempt))
    } catch (error) {
      if (!(error instanceof TransactionConflict)) throw error
    }
  }
  return reviewExternalLink(env, token, deps)
}

export async function submitExternalLink(
  env: ExternalLinkEnv,
  token: string,
  signedBase64: string,
  deps: ExternalLinkDependencies = {},
) {
  const { identity, request, intent } = await resolve(env, token)
  const attempt = await getLatestAttempt(env.DB, identity, request.id)
  if (!attempt) throw new ExternalLinkError(409, 'Transaction is not prepared')
  let signed: { signedBase64: string; signature: string }
  try {
    signed = await (deps.verify ?? verifySignedSolTransfer)(
      signedBase64,
      expected(attempt, intent),
    )
  } catch {
    throw new ExternalLinkError(
      400,
      'Signed transaction does not match this transfer',
    )
  }
  if (attempt.signedBase64 && attempt.signedBase64 !== signed.signedBase64)
    throw new ExternalLinkError(409, 'A different signature is already stored')
  if (!['issued', 'signed'].includes(attempt.state))
    return reviewExternalLink(env, token, deps)
  const rpc = await (deps.rpc ?? createSolExecutionRpc)(env)
  if (
    !attempt.lastValidBlockHeight ||
    (await rpc.blockHeight()) > BigInt(attempt.lastValidBlockHeight)
  )
    throw new ExternalLinkError(
      409,
      'Transaction lifetime has expired; outcome may be unknown',
    )
  await resolve(env, token)
  if (attempt.state === 'issued') {
    try {
      await storeVerifiedSigned(env.DB, identity, claimOf(attempt), signed)
    } catch (error) {
      if (error instanceof TransactionConflict)
        return reviewExternalLink(env, token, deps)
      throw error
    }
  }
  let submission
  try {
    submission = await claimSubmission(env.DB, identity, claimOf(attempt))
  } catch (error) {
    if (error instanceof TransactionConflict)
      return reviewExternalLink(env, token, deps)
    throw error
  }
  // Durable submission claim precedes any broadcast. Never replace these bytes.
  try {
    await resolve(env, token)
    const signature = await rpc.send(signed.signedBase64)
    if (signature !== signed.signature)
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
          'Submission outcome is unknown; check status before taking further action',
      })
    } catch {
      /* Revocation stops writes as well as new execution. */
    }
  }
  return reviewExternalLink(env, token, deps)
}
