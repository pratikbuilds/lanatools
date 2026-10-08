import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { formatUsd } from '@lanatools/contracts'
import { mcpGrant, paymentActivity, paymentSigner } from '../db/schema'
import { activeGrantFor, authorizeGrant, grantHasScope } from '../mcp-grants'
import type { GrantAccess, GrantIdentity } from '../mcp-grants'
import type { FixedCharge } from './challenge'

export type CallTarget = { method: string; origin: string; path: string }

/** The payment row was already resolved, by this call or another. */
export class NoLongerOpenError extends Error {
  override readonly name = 'NoLongerOpenError'
  constructor(id: string, from: string[]) {
    super(`Payment ${id} is no longer ${from.join(' or ')}`)
  }
}

type ClosedStatus = 'free' | 'refused' | 'failed'

/** Records a call that never reserved money: free, refused, or failed. */
export async function recordCall(
  database: D1Database,
  identity: GrantIdentity,
  target: CallTarget,
  outcome: {
    status: ClosedStatus
    httpStatus?: number
    error?: string
    charge?: FixedCharge
  },
  now = Date.now(),
) {
  await drizzle(database)
    .insert(paymentActivity)
    .values({
      id: crypto.randomUUID(),
      privyUserId: identity.userId,
      clientId: identity.clientId,
      grantId: identity.grantId,
      ...target,
      protocol: outcome.charge?.protocol,
      network: outcome.charge?.network,
      mint: outcome.charge?.mint,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      error: outcome.error,
      createdAt: now,
      completedAt: now,
    })
}

/** The enabled server signer for a user's wallet, or null. */
export async function enabledSigner(database: D1Database, userId: string) {
  return (
    (await drizzle(database)
      .select()
      .from(paymentSigner)
      .where(
        and(
          eq(paymentSigner.privyUserId, userId),
          eq(paymentSigner.status, 'enabled'),
        ),
      )
      .get()) ?? null
  )
}

// What the grant's client has committed: settled spend plus held reservations.
const COMMITTED = sql`(
  select coalesce(sum(case when a.status = 'paid' then a.settled_atomic else a.reserved_atomic end), 0)
  from payment_activity a
  where a.privy_user_id = ${mcpGrant.privyUserId}
    and a.client_id = ${mcpGrant.clientId}
    and a.status in ('paid', 'reserved', 'uncertain')
)`

/** Why a grant may not pay, in the words the agent sees. */
export const GRANT_REFUSALS: Record<Exclude<GrantAccess, 'active'>, string> = {
  revoked: 'This connection has been revoked',
  insufficient_scope: 'This connection is not allowed to make payments',
}

/**
 * Reserves the charge against the client's remaining limit and opens its
 * activity row, in one statement. D1 runs statements one at a time, so
 * concurrent calls cannot both take the last of a limit. The same statement
 * checks that the grant is active with the payments scope and that the
 * user's server signer for this wallet is still enabled, so a revocation,
 * a lowered limit, or the wallet-wide stop applies to the next call.
 *
 * Returns the activity ID, or null when the reservation was refused.
 */
export async function reserve(
  database: D1Database,
  identity: GrantIdentity,
  walletId: string,
  target: CallTarget,
  charge: FixedCharge,
  now = Date.now(),
) {
  const id = crypto.randomUUID()
  const amount = Number(charge.amount)
  const row = await drizzle(database).get<{ id: string } | undefined>(sql`
    insert into payment_activity (
      id, privy_user_id, client_id, grant_id, method, origin, path,
      protocol, status, network, mint, reserved_atomic, created_at
    )
    select ${id}, ${mcpGrant.privyUserId}, ${mcpGrant.clientId}, ${mcpGrant.id},
      ${target.method}, ${target.origin}, ${target.path}, ${charge.protocol},
      'reserved', ${charge.network}, ${charge.mint}, ${amount}, ${now}
    from ${mcpGrant}
    join payment_signer s
      on s.privy_user_id = ${mcpGrant.privyUserId}
      and s.status = 'enabled'
      and s.wallet_id = ${walletId}
    where ${activeGrantFor(identity)}
      and ${grantHasScope('payments:pay')}
      and ${mcpGrant.limitMicroUsd} - ${COMMITTED} >= ${amount}
    returning id`)
  return row?.id ?? null
}

/** Why a reservation was refused, for the tool error. */
export async function reservationRefusal(
  database: D1Database,
  identity: GrantIdentity,
  walletId: string,
) {
  // The grant may have changed since payHttp checked it.
  const access = await authorizeGrant(database, identity, 'payments:pay')
  if (access !== 'active') return GRANT_REFUSALS[access]
  const signer = await enabledSigner(database, identity.userId)
  if (signer?.walletId !== walletId)
    return 'Payments are not set up for this wallet'
  const grant = await drizzle(database)
    .select({
      limit: mcpGrant.limitMicroUsd,
      committed: sql<number>`${COMMITTED}`,
    })
    .from(mcpGrant)
    .where(activeGrantFor(identity))
    .get()
  const remaining = Math.max(0, (grant?.limit ?? 0) - (grant?.committed ?? 0))
  return `The charge is more than this client's remaining limit of ${formatUsd(remaining)}`
}

/**
 * Records the one transaction signed for a reservation. Refuses when the row
 * is no longer reserved or already has a transaction, so a released
 * reservation can never be paid.
 */
export async function recordSigning(
  database: D1Database,
  id: string,
  signed: { payerWallet: string; payerSignature: string; blockhash: string },
) {
  const [row] = await drizzle(database)
    .update(paymentActivity)
    .set(signed)
    .where(
      and(
        eq(paymentActivity.id, id),
        eq(paymentActivity.status, 'reserved'),
        isNull(paymentActivity.payerSignature),
      ),
    )
    .returning({ id: paymentActivity.id })
  if (!row) throw new Error(`Payment ${id} can no longer be signed`)
}

/** The client's reserved or uncertain rows opened before `before`. */
export async function openReservations(
  database: D1Database,
  identity: GrantIdentity,
  before: number,
) {
  return drizzle(database)
    .select()
    .from(paymentActivity)
    .where(
      and(
        eq(paymentActivity.privyUserId, identity.userId),
        eq(paymentActivity.clientId, identity.clientId),
        inArray(paymentActivity.status, ['reserved', 'uncertain']),
        lt(paymentActivity.createdAt, before),
      ),
    )
}

/**
 * Replaces a reservation with the verified spend. Only called with proof
 * from the chain, which wins over a release made on weaker evidence, such
 * as a concurrent reconciliation whose lookup missed the transaction.
 */
export async function settle(
  database: D1Database,
  id: string,
  settledAtomic: bigint,
  signature: string,
  httpStatus?: number,
  now = Date.now(),
) {
  await transition(database, id, ['reserved', 'uncertain', 'released'], {
    status: 'paid',
    settledAtomic: Number(settledAtomic),
    signature,
    httpStatus,
    error: null,
    completedAt: now,
  })
}

/**
 * Frees a reservation. Only call this when nothing was signed, the signer
 * provably refused, or the signed transaction provably never landed: any
 * other failure may have paid.
 */
export async function release(
  database: D1Database,
  id: string,
  error: string,
  httpStatus?: number,
  now = Date.now(),
) {
  await transition(database, id, ['reserved', 'uncertain'], {
    status: 'released',
    error,
    httpStatus,
    completedAt: now,
  })
}

/** Keeps the reservation held for a payment whose outcome is unknown. */
export async function markUncertain(
  database: D1Database,
  id: string,
  error: string,
  details: { signature?: string | null; httpStatus?: number } = {},
) {
  await transition(database, id, ['reserved'], {
    status: 'uncertain',
    error,
    signature: details.signature ?? null,
    httpStatus: details.httpStatus,
  })
}

async function transition(
  database: D1Database,
  id: string,
  from: Array<'reserved' | 'uncertain' | 'released'>,
  set: Partial<typeof paymentActivity.$inferInsert>,
) {
  const [row] = await drizzle(database)
    .update(paymentActivity)
    .set(set)
    .where(
      and(eq(paymentActivity.id, id), inArray(paymentActivity.status, from)),
    )
    .returning({ id: paymentActivity.id })
  if (!row) throw new NoLongerOpenError(id, from)
}
