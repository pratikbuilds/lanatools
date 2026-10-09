import { and, eq, sql } from 'drizzle-orm'
import { isAddress } from '@solana/kit'
import { readSolanaNetwork } from '@lanatools/contracts/networks'
import { z } from 'zod'
import { PreparedTransaction, TransactionReceipt } from '@lanatools/contracts'
import {
  observeSubmission,
  transactionRpc,
  verifyRpcNetwork,
  verifySignedTransaction,
} from './submission'
import type { ChainObservation, TransactionRpc } from './submission'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type {
  TransactionDelivery,
  TransactionLink,
  TransactionResult,
} from '@lanatools/contracts'
import { mcpGrant, transactionRequest } from '../db/schema'
import { authorizeGrant } from '../mcp-grants'
import type { GrantIdentity } from '../mcp-grants'
import {
  transactionOperation,
  transactionScope,
  idempotencyKey as RequestKey,
} from './tools'
import { publicTransaction } from './adapter'
import type { TransactionRegistry } from './tools'

export const PREPARATION_LEASE_MS = 30_000

export type TransactionLinkEnv = {
  DB: D1Database
  SOLANA_NETWORK: string
  WEB_ORIGIN: string
}

const ERRORS = {
  unauthorized: 'This client is not connected. Reconnect it in LanaTools.',
  insufficient_scope:
    'This client is not allowed to use this transaction tool. The user can allow it in LanaTools.',
  invalid_input: 'Invalid transaction tool or arguments.',
  conflict: 'This request key already belongs to a different transaction.',
  not_found: 'Transaction not found.',
  unavailable: 'Transactions are temporarily unavailable.',
  preparing: 'This link is being prepared. Try again shortly.',
  transaction_expired:
    'This signing session timed out. Sign again to continue.',
  closed: 'This link can no longer accept a new transaction.',
} as const

export type TransactionLinkOutcome<T> =
  | { ok: true; result: T }
  | {
      ok: false
      error: { code: keyof typeof ERRORS; message: string; retryable: boolean }
    }

function failed(code: keyof typeof ERRORS, message: string = ERRORS[code]) {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable:
        code === 'unavailable' ||
        code === 'preparing' ||
        code === 'transaction_expired',
    },
  } as const
}

function configuration(env: TransactionLinkEnv) {
  const network = readSolanaNetwork(env)
  const origin = new URL(env.WEB_ORIGIN)
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== 'https:' &&
      !(
        origin.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      ))
  )
    throw new Error('Invalid web origin')
  return { network, webOrigin: origin.origin }
}

/** What the agent sees: the shared result for any tool and delivery mode. */
function toResult(
  link: TransactionLink,
  delivery: TransactionDelivery,
  webOrigin: string,
  transaction?: PreparedTransaction,
): TransactionResult {
  return {
    id: link.id,
    tool: link.tool,
    network: link.network,
    delivery,
    status: link.status,
    review: link.review,
    ...(delivery === 'link' ? { reviewUrl: `${webOrigin}/tx/${link.id}` } : {}),
    ...(transaction ? { transaction } : {}),
    signature: link.signature,
    receipt: link.receipt,
    expiresAt: link.expiresAt,
  }
}

const RequestEnvelope = z.looseObject({
  delivery: z.enum(['link', 'local']),
  wallet: z.string().refine(isAddress).optional(),
  idempotencyKey: RequestKey,
})

/**
 * Stores a transaction intent. A link waits for its review page; a local
 * request is built at once for the agent's wallet and returned unsigned.
 */
export async function createTransactionRequest(
  env: TransactionExecutionEnv,
  identity: GrantIdentity,
  name: string,
  input: unknown,
  options: ExecutionOptions = {},
): Promise<TransactionLinkOutcome<TransactionResult>> {
  const now = options.now ?? Date.now()
  const tools = options.tools
  try {
    const tool = transactionOperation(name, tools)
    const access = await authorizeGrant(
      env.DB,
      identity,
      transactionScope(name),
      now,
    )
    if (access === 'revoked') return failed('unauthorized')
    if (access === 'insufficient_scope') return failed('insufficient_scope')
    if (!tool) return failed('invalid_input')
    const envelope = RequestEnvelope.safeParse(input)
    if (!envelope.success) return failed('invalid_input')
    const { delivery, wallet, idempotencyKey, ...rawArguments } = envelope.data
    if ((delivery === 'local') !== (wallet !== undefined))
      return failed(
        'invalid_input',
        'Local delivery needs the signing wallet; a link takes no wallet.',
      )
    const parsed = tool.arguments.safeParse(rawArguments)
    if (!parsed.success) return failed('invalid_input')
    const args = parsed.data
    const argumentsJson = JSON.stringify(args)
    const config = configuration(env)
    if (!tool.supportedNetworks.includes(config.network))
      return failed(
        'invalid_input',
        'This transaction is not supported on this deployment network.',
      )
    const db = drizzle(env.DB)
    // The insert checks the grant again atomically so concurrent revocation
    // cannot create a usable new intent after authorization was read.
    await db.run(sql`
      insert into transaction_request
        (id, tool_name, arguments_json, network, creator_user_id,
         creator_client_id, creator_grant_id, idempotency_key, delivery,
         created_at, updated_at, expires_at)
      select ${crypto.randomUUID()}, ${name}, ${argumentsJson}, ${config.network},
        ${identity.userId}, ${identity.clientId}, ${identity.grantId}, ${idempotencyKey},
        ${delivery}, ${now}, ${now}, ${now + 15 * 60_000}
      from mcp_grant where id = ${identity.grantId}
        and privy_user_id = ${identity.userId} and client_id = ${identity.clientId}
        and status = 'active'
      on conflict (creator_user_id, creator_client_id, idempotency_key) do nothing
    `)
    const row = await db
      .select()
      .from(transactionRequest)
      .where(
        and(
          eq(transactionRequest.creatorUserId, identity.userId),
          eq(transactionRequest.creatorClientId, identity.clientId),
          eq(transactionRequest.idempotencyKey, idempotencyKey),
        ),
      )
      .get()
    if (!row) return failed('unauthorized')
    if (row.creatorGrantId !== identity.grantId)
      return failed(
        'conflict',
        'This request key belongs to a previous connection. Use a new idempotency key.',
      )
    if (
      row.toolName !== name ||
      row.argumentsJson !== argumentsJson ||
      row.network !== config.network ||
      row.delivery !== delivery
    )
      return failed('conflict')
    let transaction: PreparedTransaction | undefined
    if (row.delivery === 'local' && wallet) {
      // A retry returns the same unsigned bytes while they are valid. Once a
      // signature is accepted the request is closed and only status remains.
      const prepared = await prepareTransactionLink(
        env,
        row.id,
        { account: wallet },
        { ...options, now },
      )
      if (prepared.ok) transaction = prepared.result
      else if (prepared.error.code !== 'closed') return prepared
    }
    const link = await readTransactionLink(env.DB, row.id, now, tools)
    if (!link) return failed('unavailable')
    return {
      ok: true,
      result: toResult(link, row.delivery, config.webOrigin, transaction),
    }
  } catch {
    return failed('unavailable')
  }
}

/** Read saved execution state and project link closure without changing the row. */
export async function readTransactionLink(
  database: D1Database,
  id: string,
  now = Date.now(),
  tools?: TransactionRegistry,
): Promise<TransactionLink | null> {
  const db = drizzle(database)
  const row = await db
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, id))
    .get()
  if (!row) return null
  const tool = transactionOperation(row.toolName, tools)
  if (!tool) throw new Error('Stored transaction tool is unavailable')
  const args = tool.arguments.parse(JSON.parse(row.argumentsJson))
  const grant = await db
    .select({ status: mcpGrant.status })
    .from(mcpGrant)
    .where(
      and(
        eq(mcpGrant.id, row.creatorGrantId),
        eq(mcpGrant.privyUserId, row.creatorUserId),
        eq(mcpGrant.clientId, row.creatorClientId),
      ),
    )
    .get()
  const status =
    !row.signature &&
    (['open', 'preparing', 'ready', 'transaction_expired'].includes(
      row.status,
    ) ||
      isLegacyBlockhashExpiry(row))
      ? grant?.status !== 'active'
        ? 'unavailable'
        : row.expiresAt <= now
          ? 'expired'
          : preparationLeaseExpired(row, now)
            ? row.candidateJson
              ? 'transaction_expired'
              : 'open'
            : isLegacyBlockhashExpiry(row)
              ? 'transaction_expired'
              : row.status
      : row.status
  return {
    id: row.id,
    tool: row.toolName,
    network: row.network,
    review: row.candidateJson
      ? publicTransaction(JSON.parse(row.candidateJson)).review
      : tool.describe(args),
    status,
    account:
      preparationLeaseExpired(row, now) && !row.candidateJson
        ? null
        : row.account,
    signature: row.signature,
    receipt: row.receiptJson
      ? TransactionReceipt.assert(JSON.parse(row.receiptJson))
      : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

export async function transactionStatus(
  env: TransactionExecutionEnv,
  identity: GrantIdentity,
  id: string,
  options: ExecutionOptions = {},
): Promise<TransactionLinkOutcome<TransactionResult>> {
  try {
    if ((await authorizeGrant(env.DB, identity, null)) !== 'active')
      return failed('unauthorized')
    const owned = await drizzle(env.DB)
      .select({ delivery: transactionRequest.delivery })
      .from(transactionRequest)
      .where(
        and(
          eq(transactionRequest.id, id),
          eq(transactionRequest.creatorUserId, identity.userId),
          eq(transactionRequest.creatorClientId, identity.clientId),
        ),
      )
      .get()
    if (!owned) return failed('not_found')
    const link = await observeTransactionLink(env, id, options)
    if (!link) return failed('not_found')
    const row =
      owned.delivery === 'local' && link.status === 'ready'
        ? await storedLink(env.DB, id)
        : undefined
    return {
      ok: true,
      result: toResult(
        link,
        owned.delivery,
        configuration(env).webOrigin,
        row?.candidateJson
          ? publicTransaction(JSON.parse(row.candidateJson))
          : undefined,
      ),
    }
  } catch {
    return failed('unavailable')
  }
}

export type TransactionExecutionEnv = TransactionLinkEnv & {
  SOLANA_RPC_URL: string
  JUPITER_API_KEY?: string
}
export type ExecutionOptions = {
  tools?: TransactionRegistry
  rpc?: TransactionRpc
  now?: number
  observation?: { attempts?: number; intervalMs?: number }
}
export const PrepareTransactionInput = z.strictObject({
  account: z.string().refine(isAddress),
})
export const SendTransactionInput = z.strictObject({
  transaction: z
    .string()
    .min(1)
    .max(1644)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
})

const liveGrant = sql`exists (select 1 from mcp_grant
  where mcp_grant.id = transaction_request.creator_grant_id
  and mcp_grant.privy_user_id = transaction_request.creator_user_id
  and mcp_grant.client_id = transaction_request.creator_client_id
  and mcp_grant.status = 'active')`

async function storedLink(database: D1Database, id: string) {
  return drizzle(database)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, id))
    .get()
}

function preparationLeaseExpired(
  row: typeof transactionRequest.$inferSelect,
  now: number,
) {
  return (
    row.status === 'preparing' &&
    !row.signature &&
    row.updatedAt + PREPARATION_LEASE_MS <= now
  )
}

function isLegacyBlockhashExpiry(row: typeof transactionRequest.$inferSelect) {
  return row.status === 'expired' && row.errorCode === 'blockhash_expired'
}

async function persistObservation(
  database: D1Database,
  id: string,
  signature: string,
  observed: ChainObservation,
  now: number,
) {
  await drizzle(database)
    .update(transactionRequest)
    .set({
      status: observed.status,
      receiptJson: observed.receipt ? JSON.stringify(observed.receipt) : null,
      errorCode:
        observed.status === 'failed'
          ? 'chain_failed'
          : observed.status === 'unknown'
            ? 'confirmation_unknown'
            : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(transactionRequest.id, id),
        eq(transactionRequest.signature, signature),
        sql`${transactionRequest.status} in ('submitting', 'unknown')`,
      ),
    )
    .run()
}

/** Reloads can recover chain evidence, but only a caller retaining signed bytes can relay. */
export async function observeTransactionLink(
  env: TransactionExecutionEnv,
  id: string,
  options: ExecutionOptions = {},
): Promise<TransactionLink | null> {
  const now = options.now ?? Date.now()
  const link = await readTransactionLink(env.DB, id, now, options.tools)
  if (!link) return null
  if (link.network !== configuration(env).network)
    throw new Error('Transaction network mismatch')
  if (!['ready', 'submitting', 'unknown'].includes(link.status)) return link
  const rpc = options.rpc ?? transactionRpc(env.SOLANA_RPC_URL)
  // A failing provider must not make a persisted signature disappear from GET.
  try {
    await verifyRpcNetwork(rpc, link.network)
  } catch {
    return link
  }
  if (link.signature) {
    const observed = await observeSubmission(rpc, link.signature, {
      attempts: 1,
      intervalMs: 0,
      ...options.observation,
    })
    try {
      await persistObservation(env.DB, id, link.signature, observed, now)
    } catch {
      return link
    }
  } else if (link.status === 'ready') {
    const row = await storedLink(env.DB, id)
    if (row?.candidateJson) {
      const candidate = PreparedTransaction.assert(
        JSON.parse(row.candidateJson),
      )
      const height = await rpc.blockHeight('finalized').catch(() => null)
      if (height !== null && height > BigInt(candidate.lastValidBlockHeight))
        await drizzle(env.DB)
          .update(transactionRequest)
          .set({
            status: 'transaction_expired',
            errorCode: 'blockhash_expired',
            updatedAt: now,
          })
          .where(
            and(
              eq(transactionRequest.id, id),
              eq(transactionRequest.status, 'ready'),
              eq(transactionRequest.revision, row.revision),
              sql`${transactionRequest.signature} is null`,
            ),
          )
          .run()
    }
  }
  return readTransactionLink(env.DB, id, now, options.tools).catch(() => link)
}

export async function prepareTransactionLink(
  env: TransactionExecutionEnv,
  id: string,
  input: unknown,
  options: ExecutionOptions = {},
): Promise<TransactionLinkOutcome<PreparedTransaction>> {
  const parsed = PrepareTransactionInput.safeParse(input)
  if (!parsed.success) return failed('invalid_input')
  const now = options.now ?? Date.now()
  let reservation: number | undefined
  let renewing = false
  try {
    const config = configuration(env)
    const row = await storedLink(env.DB, id)
    if (!row) return failed('not_found')
    if (row.network !== config.network) return failed('unavailable')
    const publicLink = await readTransactionLink(env.DB, id, now, options.tools)
    if (
      !publicLink ||
      row.signature ||
      !['open', 'preparing', 'ready', 'transaction_expired'].includes(
        publicLink.status,
      )
    )
      return failed('closed')
    if (
      row.account &&
      row.account !== parsed.data.account &&
      !(preparationLeaseExpired(row, now) && !row.candidateJson)
    )
      return failed(
        'conflict',
        'This link is already assigned to another wallet.',
      )
    if (row.status === 'preparing' && !preparationLeaseExpired(row, now))
      return failed('preparing')
    const rpc = options.rpc ?? transactionRpc(env.SOLANA_RPC_URL)
    const previous = row.candidateJson
      ? publicTransaction(JSON.parse(row.candidateJson))
      : null
    let finalizedHeight: bigint | undefined
    if (previous) {
      await verifyRpcNetwork(rpc, config.network)
      // Only finalized expiry proves the old message cannot later land on a surviving fork.
      finalizedHeight = await rpc.blockHeight('finalized')
      if (finalizedHeight <= BigInt(previous.lastValidBlockHeight)) {
        if (
          row.status === 'ready' &&
          (await rpc.blockHeight('confirmed')) <=
            BigInt(previous.lastValidBlockHeight)
        )
          return { ok: true, result: previous }
        return failed(
          'preparing',
          'Waiting for the previous signing session to expire. Try again shortly.',
        )
      }
      renewing = true
    }
    const db = drizzle(env.DB)
    const [reserved] = await db
      .update(transactionRequest)
      .set({
        status: 'preparing',
        account: parsed.data.account,
        revision: row.revision + 1,
        errorCode: renewing ? 'blockhash_expired' : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(transactionRequest.id, id),
          eq(transactionRequest.revision, row.revision),
          eq(transactionRequest.status, row.status),
          sql`${transactionRequest.signature} is null`,
          sql`${transactionRequest.expiresAt} > ${now}`,
          liveGrant,
        ),
      )
      .returning({ revision: transactionRequest.revision })
    if (!reserved) {
      const current = await storedLink(env.DB, id)
      return failed(current?.signature ? 'closed' : 'preparing')
    }
    reservation = reserved.revision
    if (!previous) await verifyRpcNetwork(rpc, config.network)
    const tool = transactionOperation(row.toolName, options.tools)
    if (!tool) throw new Error('Unavailable builder')
    const args = tool.arguments.parse(JSON.parse(row.argumentsJson))
    if (!tool.supportedNetworks.includes(config.network))
      throw new Error('Unsupported network')
    const candidate = await tool.build(args, parsed.data.account, {
      requestId: id,
      network: config.network,
      rpc,
      jupiterApiKey: env.JUPITER_API_KEY,
    })
    if (
      candidate.account !== parsed.data.account ||
      candidate.network !== config.network
    )
      throw new Error('Builder returned a different signer or network')
    if (
      previous &&
      (candidate.transaction === previous.transaction ||
        BigInt(candidate.lastValidBlockHeight) <= finalizedHeight!)
    )
      throw new Error('Builder returned an expired transaction')
    const completedAt = options.now ?? Date.now()
    const [persisted] = await db
      .update(transactionRequest)
      .set({
        candidateJson: JSON.stringify(candidate),
        status: 'ready',
        errorCode: null,
        revision: reservation + 1,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(transactionRequest.id, id),
          eq(transactionRequest.revision, reservation),
          eq(transactionRequest.status, 'preparing'),
          sql`${transactionRequest.signature} is null`,
          sql`${transactionRequest.updatedAt} > ${completedAt - PREPARATION_LEASE_MS}`,
          liveGrant,
          sql`${transactionRequest.expiresAt} > ${completedAt}`,
        ),
      )
      .returning({ id: transactionRequest.id })
    if (!persisted) throw new Error('Reservation no longer valid')
    return { ok: true, result: publicTransaction(candidate) }
  } catch {
    if (reservation !== undefined) {
      // A failed renewal retains the old candidate and its wallet; every cleanup is fenced.
      await drizzle(env.DB)
        .update(transactionRequest)
        .set({
          status: renewing ? 'transaction_expired' : 'open',
          account: renewing ? parsed.data.account : null,
          revision: reservation + 1,
          updatedAt: options.now ?? Date.now(),
        })
        .where(
          and(
            eq(transactionRequest.id, id),
            eq(transactionRequest.revision, reservation),
            eq(transactionRequest.status, 'preparing'),
            sql`${transactionRequest.signature} is null`,
          ),
        )
        .run()
        .catch(() => undefined)
    }
    return failed('unavailable')
  }
}

export async function sendTransactionLink(
  env: TransactionExecutionEnv,
  id: string,
  input: unknown,
  options: ExecutionOptions = {},
): Promise<TransactionLinkOutcome<TransactionLink>> {
  const parsed = SendTransactionInput.safeParse(input)
  if (!parsed.success) return failed('invalid_input')
  try {
    const config = configuration(env)
    const row = await storedLink(env.DB, id)
    if (!row) return failed('not_found')
    if (row.network !== config.network) return failed('unavailable')
    if (!row.candidateJson)
      return failed('conflict', 'This link has no transaction to send.')
    const candidate = PreparedTransaction.assert(JSON.parse(row.candidateJson))
    let extracted: string
    try {
      extracted = await verifySignedTransaction(
        parsed.data.transaction,
        candidate,
      )
    } catch {
      return failed('invalid_input')
    }
    if (row.signature && row.signature !== extracted)
      return failed(
        'conflict',
        'This link already has an accepted transaction.',
      )
    const snapshot = async () => {
      const result = await readTransactionLink(
        env.DB,
        id,
        options.now ?? Date.now(),
        options.tools,
      )
      return result ? { ok: true as const, result } : failed('not_found')
    }
    if (row.status === 'confirmed' || row.status === 'failed') return snapshot()
    if (!row.signature) {
      const link = await readTransactionLink(
        env.DB,
        id,
        options.now ?? Date.now(),
        options.tools,
      )
      if (!link || ['expired', 'unavailable'].includes(link.status))
        return failed('closed')
    }
    const rpc = options.rpc ?? transactionRpc(env.SOLANA_RPC_URL)
    await verifyRpcNetwork(rpc, config.network)
    const tool = transactionOperation(row.toolName, options.tools)
    if (!tool || !tool.supportedNetworks.includes(config.network))
      return failed('unavailable')
    const relay = tool.relay(JSON.parse(row.candidateJson), {
      requestId: id,
      network: config.network,
      rpc,
      jupiterApiKey: env.JUPITER_API_KEY,
    })
    const db = drizzle(env.DB)
    if (row.signature) {
      const observed = await observeSubmission(rpc, extracted, { attempts: 1 })
      if (observed.status !== 'unknown') {
        await persistObservation(
          env.DB,
          id,
          extracted,
          observed,
          options.now ?? Date.now(),
        )
        return snapshot()
      }
    }
    const height = await rpc.blockHeight('confirmed').catch(() => null)
    const stillValid =
      height !== null && height <= BigInt(candidate.lastValidBlockHeight)
    if (!row.signature) {
      if (height === null) return failed('unavailable')
      if (!stillValid) {
        const finalizedHeight = await rpc
          .blockHeight('finalized')
          .catch(() => null)
        if (
          finalizedHeight === null ||
          finalizedHeight <= BigInt(candidate.lastValidBlockHeight)
        )
          return failed(
            'unavailable',
            'This signing session is ending. Retry shortly to check its final status.',
          )
        await db
          .update(transactionRequest)
          .set({
            status: 'transaction_expired',
            errorCode: 'blockhash_expired',
            updatedAt: options.now ?? Date.now(),
          })
          .where(
            and(
              eq(transactionRequest.id, id),
              eq(transactionRequest.status, 'ready'),
              eq(transactionRequest.revision, row.revision),
              sql`${transactionRequest.signature} is null`,
            ),
          )
          .run()
        const current = await storedLink(env.DB, id)
        if (!current) return failed('not_found')
        if (!current.signature) return failed('transaction_expired')
        if (current.signature !== extracted)
          return failed(
            'conflict',
            'This link already has an accepted transaction.',
          )
        const observed = await observeSubmission(
          rpc,
          extracted,
          options.observation,
        )
        await persistObservation(
          env.DB,
          id,
          extracted,
          observed,
          options.now ?? Date.now(),
        )
        return snapshot()
      }
      const now = options.now ?? Date.now()
      const [accepted] = await db
        .update(transactionRequest)
        .set({
          signature: extracted,
          status: 'submitting',
          revision: row.revision + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(transactionRequest.id, id),
            eq(transactionRequest.revision, row.revision),
            eq(transactionRequest.status, 'ready'),
            sql`${transactionRequest.signature} is null`,
            liveGrant,
            sql`${transactionRequest.expiresAt} > ${now}`,
          ),
        )
        .returning({ signature: transactionRequest.signature })
      if (!accepted) {
        const current = await storedLink(env.DB, id)
        if (!current?.signature) {
          if (
            current &&
            (current.status === 'transaction_expired' ||
              (current.revision !== row.revision &&
                ['preparing', 'ready'].includes(current.status)))
          )
            return failed('transaction_expired')
          return failed('closed')
        }
        if (current.signature !== extracted)
          return failed(
            'conflict',
            'This link already has an accepted transaction.',
          )
        if (current.status === 'confirmed' || current.status === 'failed')
          return snapshot()
      }
    }
    // Recheck closure after acceptance. A revoked/expired link can still be observed,
    // but cannot authorize another relay of the caller's retained payload.
    const relayAllowed = await db
      .select({ id: transactionRequest.id })
      .from(transactionRequest)
      .where(
        and(
          eq(transactionRequest.id, id),
          eq(transactionRequest.signature, extracted),
          sql`${transactionRequest.status} in ('submitting', 'unknown')`,
          liveGrant,
          sql`${transactionRequest.expiresAt} > ${options.now ?? Date.now()}`,
        ),
      )
      .get()
    if (stillValid && relayAllowed) {
      try {
        const sent = await relay(parsed.data.transaction)
        if (sent !== extracted)
          throw new Error('Submission returned a different signature')
      } catch {
        // A lost response may follow a successful broadcast. Observe the signature.
      }
    }
    const observed = await observeSubmission(
      rpc,
      extracted,
      options.observation,
    )
    await persistObservation(
      env.DB,
      id,
      extracted,
      observed,
      options.now ?? Date.now(),
    )
    return snapshot()
  } catch {
    return failed('unavailable')
  }
}

/** The delivery a stored request uses, or null when there is no such request. */
export async function requestDelivery(database: D1Database, id: string) {
  const row = await drizzle(database)
    .select({ delivery: transactionRequest.delivery })
    .from(transactionRequest)
    .where(eq(transactionRequest.id, id))
    .get()
  return row?.delivery ?? null
}

/** Accepts the agent's signed bytes for its own local request, then relays them. */
export async function sendTransaction(
  env: TransactionExecutionEnv,
  identity: GrantIdentity,
  id: string,
  input: unknown,
  options: ExecutionOptions = {},
): Promise<TransactionLinkOutcome<TransactionResult>> {
  try {
    if ((await authorizeGrant(env.DB, identity, null)) !== 'active')
      return failed('unauthorized')
    const owned = await drizzle(env.DB)
      .select({ delivery: transactionRequest.delivery })
      .from(transactionRequest)
      .where(
        and(
          eq(transactionRequest.id, id),
          eq(transactionRequest.creatorUserId, identity.userId),
          eq(transactionRequest.creatorClientId, identity.clientId),
        ),
      )
      .get()
    if (!owned) return failed('not_found')
    if (owned.delivery !== 'local')
      return failed(
        'invalid_input',
        'Only local transactions are sent here. A link is signed on its review page.',
      )
    const sent = await sendTransactionLink(env, id, input, options)
    if (!sent.ok) return sent
    return {
      ok: true,
      result: toResult(sent.result, 'local', configuration(env).webOrigin),
    }
  } catch {
    return failed('unavailable')
  }
}
