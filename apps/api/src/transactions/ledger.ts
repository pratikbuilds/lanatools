import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { type } from 'arktype'
import {
  address,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isAddress,
  isSignature,
} from '@solana/kit'
import type { D1Database } from '@cloudflare/workers-types'
import type {
  AttemptState,
  PreparedTransaction,
  TransactionEvidence,
  TransactionResult,
} from '@lanatools/contracts'
import { mcpGrant, transactionAttempt, transactionRequest } from '../db/schema'
import { activeGrantFor } from '../mcp-grants'
import type { GrantIdentity } from '../mcp-grants'
import { hashBytes, normalizeInput } from './input'
import type { RequestContext } from './input'

type Request = typeof transactionRequest.$inferSelect
type Attempt = typeof transactionAttempt.$inferSelect
type Claim = { attemptId: string; token: string }

export class TransactionConflict extends Error {
  override readonly name = 'TransactionConflict'
}

const access = (identity: GrantIdentity) => sql`exists (
  select 1 from ${mcpGrant} where ${activeGrantFor(identity)}
)`
const ownsRequest = (identity: GrantIdentity) =>
  and(
    eq(transactionRequest.privyUserId, identity.userId),
    eq(transactionRequest.clientId, identity.clientId),
    access(identity),
  )
const ownsAttempt = (identity: GrantIdentity) => sql`exists (
  select 1 from ${transactionRequest}
  where ${transactionRequest.id} = ${transactionAttempt.requestId}
    and ${ownsRequest(identity)}
)`

async function loadRequest(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
) {
  const request = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(and(eq(transactionRequest.id, requestId), ownsRequest(identity)))
    .get()
  if (!request) throw new Error('Transaction request is unavailable')
  return request
}

function safeResult(request: Request, attempt?: Attempt): TransactionResult {
  return {
    requestId: request.id,
    state:
      request.status === 'refused'
        ? 'refused'
        : (attempt?.state ?? 'requested'),
    attemptId: attempt?.id ?? null,
    signature: attempt?.signature ?? null,
    reason: request.refusal,
  }
}

/** Current client identity is checked; origin grant IDs remain historical. */
export async function getRequest(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
) {
  const request = await loadRequest(db, identity, requestId)
  const attempt = await getLatestAttempt(db, identity, requestId)
  return safeResult(request, attempt)
}

/** Trusted recovery code only; never include this material in agent results. */
export async function getLatestAttempt(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
) {
  await loadRequest(db, identity, requestId)
  return drizzle(db)
    .select()
    .from(transactionAttempt)
    .where(
      and(eq(transactionAttempt.requestId, requestId), ownsAttempt(identity)),
    )
    .orderBy(desc(transactionAttempt.number))
    .get()
}

export async function createRequest(
  db: D1Database,
  identity: GrantIdentity,
  input: unknown,
  context: RequestContext,
  now = Date.now(),
) {
  const intent = await normalizeInput(input, context)
  await drizzle(db).run(sql`
    insert into transaction_request (
      id, privy_user_id, client_id, originating_grant_id, idempotency_key,
      canonical_input, input_hash, execution, network, wallet_address, created_at
    ) select ${crypto.randomUUID()}, ${mcpGrant.privyUserId}, ${mcpGrant.clientId},
      ${mcpGrant.id}, ${intent.idempotencyKey}, ${intent.canonicalInput},
      ${intent.inputHash}, ${intent.execution}, ${intent.network}, ${intent.walletAddress}, ${now}
    from ${mcpGrant} where ${activeGrantFor(identity)}
    on conflict(privy_user_id, client_id, idempotency_key) do nothing
  `)
  const request = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(
      and(
        ownsRequest(identity),
        eq(transactionRequest.idempotencyKey, intent.idempotencyKey),
      ),
    )
    .get()
  if (!request) throw new Error('Transaction request is unavailable')
  if (
    request.canonicalInput !== intent.canonicalInput ||
    request.inputHash !== intent.inputHash
  )
    throw new TransactionConflict(
      'This idempotency key already names a different transaction',
    )
  return getRequest(db, identity, request.id)
}

/** Refusals are durable; they cannot replace a possibly executable attempt. */
export async function refuseRequest(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
  reason: string,
) {
  const refusal = type('1 <= string <= 512').assert(reason)
  const [row] = await drizzle(db)
    .update(transactionRequest)
    .set({ status: 'refused', refusal })
    .where(
      and(
        ownsRequest(identity),
        eq(transactionRequest.id, requestId),
        eq(transactionRequest.status, 'pending'),
        sql`not exists (select 1 from ${transactionAttempt} where ${transactionAttempt.requestId} = ${transactionRequest.id} and ${transactionAttempt.state} != 'abandoned')`,
      ),
    )
    .returning()
  if (!row)
    throw new TransactionConflict(
      'Request cannot be refused in its current state',
    )
  return safeResult(row)
}

/** Selection binds once without changing the original canonical intent. */
export async function selectExternalWallet(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
  walletAddress: string,
) {
  if (!isAddress(walletAddress)) throw new Error('Invalid external wallet')
  const [row] = await drizzle(db)
    .update(transactionRequest)
    .set({ walletAddress })
    .where(
      and(
        ownsRequest(identity),
        eq(transactionRequest.id, requestId),
        eq(transactionRequest.execution, 'external'),
        eq(transactionRequest.status, 'pending'),
        sql`(${transactionRequest.walletAddress} is null or ${transactionRequest.walletAddress} = ${walletAddress})`,
      ),
    )
    .returning()
  if (!row)
    throw new TransactionConflict('External wallet does not match the request')
}

/** A null result grants no permission. Claims have no clock-based expiry. */
export async function claimPreparation(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
  now = Date.now(),
): Promise<Claim | null> {
  const attemptId = crypto.randomUUID(),
    token = crypto.randomUUID()
  const row = await drizzle(db).get<{ id: string } | undefined>(sql`
    insert into transaction_attempt (
      id, request_id, number, state, claim_token, wallet_address, network, created_at, updated_at
    ) select ${attemptId}, r.id,
      coalesce((select max(a.number) from transaction_attempt a where a.request_id = r.id), 0) + 1,
      'preparing', ${token}, r.wallet_address, r.network, ${now}, ${now}
    from transaction_request r where r.id = ${requestId}
      and r.privy_user_id = ${identity.userId} and r.client_id = ${identity.clientId}
      and ${access(identity)} and r.status = 'pending' and r.wallet_address is not null
      and not exists (select 1 from transaction_attempt a where a.request_id = r.id and a.state != 'abandoned')
    returning id
  `)
  return row ? { attemptId, token } : null
}

async function changeAttempt(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
  from: AttemptState[],
  set: Partial<typeof transactionAttempt.$inferInsert>,
  execution?: 'embedded' | 'external',
) {
  const [row] = await drizzle(db)
    .update(transactionAttempt)
    .set({ ...set, updatedAt: Date.now() })
    .where(
      and(
        eq(transactionAttempt.id, claim.attemptId),
        eq(transactionAttempt.claimToken, claim.token),
        inArray(transactionAttempt.state, from),
        ownsAttempt(identity),
        execution === undefined
          ? undefined
          : sql`exists (select 1 from ${transactionRequest} where ${transactionRequest.id} = ${transactionAttempt.requestId} and ${transactionRequest.execution} = ${execution})`,
      ),
    )
    .returning()
  if (!row)
    throw new TransactionConflict(
      'Attempt changed, is already claimed, or is unavailable',
    )
  return row
}

function wireBytes(value: string) {
  if (!value || value.length > 8192)
    throw new Error('Invalid transaction bytes')
  const bytes = getBase64Encoder().encode(value)
  if (getBase64Decoder().decode(bytes) !== value)
    throw new Error('Use canonical base64 bytes')
  return new Uint8Array(bytes)
}

const UnsignedInteger = type('string').narrow(
  (value, ctx) =>
    /^(0|[1-9]\d{0,19})$/.test(value) ||
    ctx.reject('an unsigned integer string'),
)

export async function storePrepared(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
  prepared: PreparedTransaction,
) {
  UnsignedInteger.assert(prepared.preparationSlot)
  UnsignedInteger.assert(prepared.lastValidBlockHeight)
  if (!isAddress(prepared.blockhash)) throw new Error('Invalid blockhash')
  const bytes = wireBytes(prepared.messageBase64)
  const message = getCompiledTransactionMessageDecoder().decode(bytes)
  if (
    message.lifetimeToken !== prepared.blockhash ||
    !message.staticAccounts
      .slice(0, message.header.numSignerAccounts)
      .includes(address(prepared.walletAddress))
  )
    throw new Error('Prepared message wallet or blockhash mismatch')
  const messageHash = await hashBytes(bytes)
  // Wallet/network predicates are part of the write, not a racy earlier read.
  const [row] = await drizzle(db)
    .update(transactionAttempt)
    .set({
      state: 'prepared',
      messageBase64: prepared.messageBase64,
      messageHash,
      preparationSlot: prepared.preparationSlot,
      blockhash: prepared.blockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(transactionAttempt.id, claim.attemptId),
        eq(transactionAttempt.claimToken, claim.token),
        eq(transactionAttempt.state, 'preparing'),
        eq(transactionAttempt.walletAddress, prepared.walletAddress),
        eq(transactionAttempt.network, prepared.network),
        ownsAttempt(identity),
      ),
    )
    .returning()
  if (!row)
    throw new TransactionConflict(
      'Prepared transaction does not match the claimed attempt',
    )
}

export async function abandonPreparation(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
) {
  await changeAttempt(db, identity, claim, ['preparing'], {
    state: 'abandoned',
  })
}

/** Persist exposure before issuing bytes to an external signer. */
export async function issueAttempt(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
) {
  const attempt = await changeAttempt(
    db,
    identity,
    claim,
    ['prepared'],
    { state: 'issued' },
    'external',
  )
  return attempt.messageBase64
}

/** The returned token/message is permission for exactly one signing call. */
export async function claimSigning(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
) {
  const token = crypto.randomUUID()
  const attempt = await changeAttempt(
    db,
    identity,
    claim,
    ['prepared'],
    { state: 'signing', claimToken: token },
    'embedded',
  )
  return { attemptId: attempt.id, token, messageBase64: attempt.messageBase64 }
}

/**
 * Only a trusted signature verifier calls this. Checks byte/message identity
 * here; cryptographic signature verification belongs to the signing boundary.
 */
export async function storeVerifiedSigned(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
  signed: { signedBase64: string; signature: string },
) {
  const transaction = getTransactionDecoder().decode(
    wireBytes(signed.signedBase64),
  )
  const signature = getSignatureFromTransaction(transaction)
  if (signature !== signed.signature)
    throw new Error('Signed transaction signature mismatch')
  const attempt = await drizzle(db)
    .select()
    .from(transactionAttempt)
    .where(
      and(
        eq(transactionAttempt.id, claim.attemptId),
        eq(transactionAttempt.claimToken, claim.token),
        ownsAttempt(identity),
      ),
    )
    .get()
  if (!attempt || !transaction.signatures[address(attempt.walletAddress)])
    throw new TransactionConflict(
      'Signed transaction lacks the selected wallet signature',
    )
  if (
    attempt.signedBase64 === signed.signedBase64 &&
    attempt.signature === signature
  )
    return
  const messageHash = await hashBytes(new Uint8Array(transaction.messageBytes))
  const [row] = await drizzle(db)
    .update(transactionAttempt)
    .set({
      state: 'signed',
      signedBase64: signed.signedBase64,
      signature,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(transactionAttempt.id, claim.attemptId),
        eq(transactionAttempt.claimToken, claim.token),
        inArray(transactionAttempt.state, ['signing', 'issued']),
        ownsAttempt(identity),
        eq(transactionAttempt.messageHash, messageHash),
        eq(
          transactionAttempt.messageBase64,
          getBase64Decoder().decode(transaction.messageBytes),
        ),
      ),
    )
    .returning()
  if (!row)
    throw new TransactionConflict(
      'Signed transaction does not match the attempt',
    )
}

export async function claimSubmission(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
) {
  const token = crypto.randomUUID()
  const attempt = await changeAttempt(db, identity, claim, ['signed'], {
    state: 'submitting',
    claimToken: token,
  })
  return { attemptId: attempt.id, token, signedBase64: attempt.signedBase64 }
}

const Evidence = type({ kind: "'rpc_accepted'", signature: 'string' })
  .or({ kind: "'transport_unknown'", reason: '1 <= string <= 512' })
  .or({
    kind: "'chain_success' | 'chain_failure'",
    signature: 'string',
    slot: UnsignedInteger,
    commitment: "'confirmed' | 'finalized'",
    reason: 'string | null',
  })
  .or({
    kind: "'expiry_reconciled'",
    checkedBlockHeight: UnsignedInteger,
    historyChecked: 'true',
  })

/** Never exposed as an agent tool; evidence must be independently verified. */
export async function recordOutcome(
  db: D1Database,
  identity: GrantIdentity,
  claim: Claim,
  rawEvidence: TransactionEvidence,
) {
  const evidence = Evidence.assert(rawEvidence)
  const attempt = await drizzle(db)
    .select()
    .from(transactionAttempt)
    .where(
      and(
        eq(transactionAttempt.id, claim.attemptId),
        eq(transactionAttempt.claimToken, claim.token),
        ownsAttempt(identity),
      ),
    )
    .get()
  if (!attempt) throw new TransactionConflict('Attempt is unavailable')
  if (
    'signature' in evidence &&
    (!isSignature(evidence.signature) ||
      attempt.signature !== evidence.signature)
  )
    throw new TransactionConflict(
      'Outcome signature does not match the stored transaction',
    )
  // Confirmation can gain finality, but terminal evidence cannot regress.
  if (
    (attempt.state === 'succeeded' || attempt.state === 'failed') &&
    (evidence.kind === 'chain_success' || evidence.kind === 'chain_failure')
  ) {
    const previous = Evidence.assert(JSON.parse(attempt.evidence ?? 'null'))
    if (
      previous.kind !== evidence.kind ||
      (previous.commitment === 'finalized' &&
        evidence.commitment !== 'finalized')
    )
      throw new TransactionConflict('Terminal evidence cannot regress')
    const [row] = await drizzle(db)
      .update(transactionAttempt)
      .set({ evidence: JSON.stringify(evidence), updatedAt: Date.now() })
      .where(
        and(
          eq(transactionAttempt.id, claim.attemptId),
          eq(transactionAttempt.claimToken, claim.token),
          eq(transactionAttempt.state, attempt.state),
          eq(transactionAttempt.evidence, attempt.evidence ?? ''),
          ownsAttempt(identity),
        ),
      )
      .returning({ id: transactionAttempt.id })
    if (!row)
      throw new TransactionConflict('Terminal evidence changed concurrently')
    return
  }
  let state: AttemptState
  let from: AttemptState[]
  switch (evidence.kind) {
    case 'rpc_accepted':
      state = 'submitted'
      from = ['submitting']
      break
    case 'transport_unknown':
      state = 'uncertain'
      from = ['issued', 'signing', 'submitting']
      break
    case 'chain_success':
      state = 'succeeded'
      from = ['signed', 'submitting', 'submitted', 'uncertain']
      break
    case 'chain_failure':
      state = 'failed'
      from = ['signed', 'submitting', 'submitted', 'uncertain']
      break
    case 'expiry_reconciled':
      if (
        !attempt.lastValidBlockHeight ||
        BigInt(evidence.checkedBlockHeight) <=
          BigInt(attempt.lastValidBlockHeight)
      )
        throw new TransactionConflict('Attempt lifetime has not expired')
      state = 'expired'
      from = [
        'prepared',
        'issued',
        'signing',
        'signed',
        'submitting',
        'submitted',
        'uncertain',
      ]
      break
  }
  await changeAttempt(db, identity, claim, from, {
    state,
    evidence: JSON.stringify(evidence),
  })
}
