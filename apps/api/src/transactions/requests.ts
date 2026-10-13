import { and, eq, sql } from 'drizzle-orm'
import {
  TransactionNotSubmittedError,
  TransactionPreparationError,
} from '@lanatools/toolkit/transactions'
import { isAddress, isSolanaError } from '@solana/kit'
import { readSolanaNetwork } from '@lanatools/contracts/networks'
import { z } from 'zod'
import {
  PreparedTransaction,
  TransactionReceipt,
  TransactionReview,
} from '@lanatools/contracts'
import {
  observeSubmission,
  restoreSignedTransaction,
  transactionRpc,
  verifyRpcNetwork,
  verifySignedTransaction,
  verifyTransactionMessage,
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
import {
  embeddedWallet,
  privyEmbeddedSigner,
  privyEmbeddedMessageSigner,
} from './embedded'
import type {
  EmbeddedSigner,
  EmbeddedSignerEnv,
  EmbeddedMessageSigner,
} from './embedded'
import { PolicyDeniedError } from '../payments/privy-signer'
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
  preparation_refused: 'This transaction could not be prepared.',
  conflict: 'This request key already belongs to a different transaction.',
  not_found: 'Transaction not found.',
  unavailable: 'Transactions are temporarily unavailable.',
  preparing: 'This link is being prepared. Try again shortly.',
  transaction_expired:
    'This signing session timed out. Sign again to continue.',
  closed: 'This link can no longer accept a new transaction.',
  embedded_unavailable:
    'Signing with the LanaTools wallet is not set up. The user can set it up by opening LanaTools.',
  signing_refused:
    "The LanaTools wallet's signing policy refused this transaction.",
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

export function configuration(env: TransactionLinkEnv) {
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
  delivery: z.enum(['link', 'local', 'embedded']),
  wallet: z.string().refine(isAddress).optional(),
  idempotencyKey: RequestKey,
})

/**
 * Stores a transaction intent. A link waits for its review page; a local
 * request is built at once for the agent's wallet and returned unsigned; an
 * embedded request is built, signed with the user's LanaTools wallet and sent.
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
        'Local delivery needs the signing wallet; link and embedded take no wallet.',
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
    const embedded =
      delivery === 'embedded'
        ? {
            wallet: await embeddedWallet(env.DB, identity.userId),
            sign:
              options.embeddedSigner === undefined
                ? privyEmbeddedSigner(env)
                : options.embeddedSigner,
          }
        : null
    if (embedded && (!embedded.wallet || !embedded.sign))
      return failed('embedded_unavailable')
    const db = drizzle(env.DB)
    const id = crypto.randomUUID()
    const counterparty = tool.counterparty(args)
    // Names a review shows (such as token symbols) are looked up once, here.
    const review = await tool.review(args, {
      requestId: id,
      network: config.network,
      rpc: options.rpc ?? transactionRpc(env.SOLANA_RPC_URL),
      jupiterApiKey: env.JUPITER_API_KEY,
    })
    // Recheck access atomically so concurrent revocation or wallet removal wins.
    await db.run(sql`
      insert into transaction_request
        (id, tool_name, arguments_json, network, creator_user_id,
         creator_client_id, creator_grant_id, idempotency_key, delivery,
         review_json, account, counterparty, created_at, updated_at, expires_at)
      select ${id}, ${name}, ${argumentsJson}, ${config.network},
        ${identity.userId}, ${identity.clientId}, ${identity.grantId}, ${idempotencyKey},
        ${delivery}, ${JSON.stringify(review)}, ${embedded?.wallet?.walletAddress ?? null},
        ${counterparty}, ${now}, ${now}, ${now + 15 * 60_000}
      from mcp_grant where id = ${identity.grantId}
        and privy_user_id = ${identity.userId} and client_id = ${identity.clientId}
        and status = 'active'
        and (${delivery} != 'embedded' or exists (
          select 1 from payment_signer
          where privy_user_id = ${identity.userId} and status = 'enabled'
            and wallet_id = ${embedded?.wallet?.walletId ?? null}
            and transaction_policy_id is not null))
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
    if (!row)
      return failed(
        (await authorizeGrant(env.DB, identity, null, now)) === 'active'
          ? 'embedded_unavailable'
          : 'unauthorized',
      )
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
    if (row.delivery === 'embedded' && embedded?.wallet && embedded.sign) {
      let signed: string
      let messageSignature: string | undefined
      if (row.signature && row.candidateJson) {
        signed = restoreSignedTransaction(
          publicTransaction(JSON.parse(row.candidateJson)),
          row.signature,
        )
      } else {
        const prepared = await prepareTransactionLink(
          env,
          row.id,
          { account: embedded.wallet.walletAddress },
          { ...options, now },
        )
        if (!prepared.ok) return prepared
        const currentWallet = await embeddedWallet(env.DB, identity.userId)
        if (
          currentWallet?.walletId !== embedded.wallet.walletId ||
          currentWallet.walletAddress !== embedded.wallet.walletAddress
        )
          return failed('embedded_unavailable')
        try {
          if (prepared.result.messageToSign) {
            const signMessage =
              options.embeddedMessageSigner ?? privyEmbeddedMessageSigner(env)
            if (!signMessage) return failed('embedded_unavailable')
            messageSignature = await signMessage(
              embedded.wallet,
              prepared.result.messageToSign,
            )
          }
          signed = await embedded.sign(
            embedded.wallet,
            prepared.result.transaction,
          )
        } catch (error) {
          return failed(
            error instanceof PolicyDeniedError
              ? 'signing_refused'
              : 'unavailable',
          )
        }
      }
      const sent = await sendTransactionLink(
        env,
        row.id,
        {
          transaction: signed,
          ...(messageSignature ? { messageSignature } : {}),
        },
        options,
      )
      if (!sent.ok) return sent
      return {
        ok: true,
        result: toResult(sent.result, 'embedded', config.webOrigin),
      }
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
export type TransactionRequestRow = typeof transactionRequest.$inferSelect

/**
 * The link a stored row describes, given whether its grant and wallet are
 * still available. Pure, so the dashboard's list can project many rows
 * without a lookup per row.
 */
export function projectTransactionLink(
  row: TransactionRequestRow,
  available: boolean,
  now = Date.now(),
  tools?: TransactionRegistry,
): TransactionLink {
  const review = row.candidateJson
    ? publicTransaction(JSON.parse(row.candidateJson)).review
    : row.reviewJson
      ? TransactionReview.assert(JSON.parse(row.reviewJson))
      : legacyReview()
  function legacyReview() {
    const tool = transactionOperation(row.toolName, tools)
    if (!tool) throw new Error('Stored transaction tool is unavailable')
    return tool.describe(tool.arguments.parse(JSON.parse(row.argumentsJson)))
  }
  const status =
    !row.signature &&
    (['open', 'preparing', 'ready', 'transaction_expired'].includes(
      row.status,
    ) ||
      isLegacyBlockhashExpiry(row))
      ? !available
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
    review,
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
  const walletAvailable =
    row.delivery !== 'embedded' ||
    !!row.signature ||
    (await embeddedWallet(database, row.creatorUserId))?.walletAddress ===
      row.account
  return projectTransactionLink(
    row,
    grant?.status === 'active' && walletAvailable,
    now,
    tools,
  )
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

export type TransactionExecutionEnv = TransactionLinkEnv &
  EmbeddedSignerEnv & {
    SOLANA_RPC_URL: string
    JUPITER_API_KEY?: string
  }
export type ExecutionOptions = {
  tools?: TransactionRegistry
  rpc?: TransactionRpc
  now?: number
  observation?: { attempts?: number; intervalMs?: number }
  /** Replaces the Privy signer, or null for a deployment without one. */
  embeddedSigner?: EmbeddedSigner | null
  embeddedMessageSigner?: EmbeddedMessageSigner
}
export const PrepareTransactionInput = z.strictObject({
  account: z.string().refine(isAddress),
})
export const SendTransactionInput = z.strictObject({
  messageSignature: z
    .string()
    .min(64)
    .max(88)
    .regex(/^[1-9A-HJ-NP-Za-km-z]+$/)
    .optional(),
  transaction: z
    .string()
    .min(1)
    .max(1644)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
})

/** The creator's grant is active and, for embedded delivery, its wallet still signs. */
export const liveAccess = sql`exists (select 1 from mcp_grant
  where mcp_grant.id = transaction_request.creator_grant_id
  and mcp_grant.privy_user_id = transaction_request.creator_user_id
  and mcp_grant.client_id = transaction_request.creator_client_id
  and mcp_grant.status = 'active')
  and (transaction_request.delivery != 'embedded' or exists (
    select 1 from payment_signer
    where payment_signer.privy_user_id = transaction_request.creator_user_id
      and payment_signer.status = 'enabled'
      and payment_signer.wallet_address = transaction_request.account
      and payment_signer.transaction_policy_id is not null))`

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
  errorCode?: string,
) {
  await drizzle(database)
    .update(transactionRequest)
    .set({
      status: observed.status,
      receiptJson: observed.receipt ? JSON.stringify(observed.receipt) : null,
      errorCode:
        errorCode ??
        (observed.status === 'failed'
          ? 'chain_failed'
          : observed.status === 'expired'
            ? 'blockhash_expired'
            : observed.status === 'unknown'
              ? 'confirmation_unknown'
              : null),
      updatedAt: now,
    })
    .where(
      and(
        eq(transactionRequest.id, id),
        eq(transactionRequest.signature, signature),
        observed.status === 'confirmed' || observed.status === 'failed'
          ? sql`${transactionRequest.status} in ('submitting', 'unknown', 'expired')`
          : sql`${transactionRequest.status} in ('submitting', 'unknown')`,
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
  if (
    !['ready', 'submitting', 'unknown'].includes(link.status) &&
    !(link.status === 'expired' && link.signature)
  )
    return link
  const rpc = options.rpc ?? transactionRpc(env.SOLANA_RPC_URL)
  // A failing provider must not make a persisted signature disappear from GET.
  try {
    await verifyRpcNetwork(rpc, link.network)
  } catch {
    return link
  }
  if (link.signature) {
    const row = await storedLink(env.DB, id)
    const candidate = row?.candidateJson
      ? PreparedTransaction.assert(JSON.parse(row.candidateJson))
      : null
    const observed = await observeSubmission(rpc, link.signature, {
      attempts: 1,
      intervalMs: 0,
      ...options.observation,
      ...(candidate
        ? { lastValidBlockHeight: candidate.lastValidBlockHeight }
        : {}),
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
  let embedded = false
  try {
    const config = configuration(env)
    const row = await storedLink(env.DB, id)
    if (!row) return failed('not_found')
    embedded = row.delivery === 'embedded'
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
          liveAccess,
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
          liveAccess,
          sql`${transactionRequest.expiresAt} > ${completedAt}`,
        ),
      )
      .returning({ id: transactionRequest.id })
    if (!persisted) throw new Error('Reservation no longer valid')
    return { ok: true, result: publicTransaction(candidate) }
  } catch (error) {
    if (reservation !== undefined) {
      // Keep the wallet for embedded requests and renewals; every cleanup is fenced.
      await drizzle(env.DB)
        .update(transactionRequest)
        .set({
          status: renewing ? 'transaction_expired' : 'open',
          account: renewing || embedded ? parsed.data.account : null,
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
    return error instanceof TransactionPreparationError
      ? failed('preparation_refused', error.message)
      : failed('unavailable')
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
      if (!row.signature)
        await verifyTransactionMessage(candidate, parsed.data.messageSignature)
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
    if (
      ['confirmed', 'failed', 'expired'].includes(row.status) &&
      row.signature
    )
      return snapshot()
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
    let acceptedHere = false
    if (row.signature) {
      const observed = await observeSubmission(rpc, extracted, {
        attempts: 1,
        lastValidBlockHeight: candidate.lastValidBlockHeight,
      })
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
        const observed = await observeSubmission(rpc, extracted, {
          ...options.observation,
          lastValidBlockHeight: candidate.lastValidBlockHeight,
        })
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
            liveAccess,
            sql`${transactionRequest.expiresAt} > ${now}`,
          ),
        )
        .returning({ signature: transactionRequest.signature })
      acceptedHere = !!accepted
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
          liveAccess,
          sql`${transactionRequest.expiresAt} > ${options.now ?? Date.now()}`,
        ),
      )
      .get()
    if (
      stillValid &&
      relayAllowed &&
      (tool.resubmit !== false || acceptedHere)
    ) {
      try {
        const sent = await relay(
          parsed.data.transaction,
          parsed.data.messageSignature,
        )
        if (sent !== extracted)
          throw new Error('Submission returned a different signature')
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: 'transaction_relay_error',
            requestId: id,
            tool: row.toolName,
            signature: extracted,
            code: isSolanaError(error)
              ? error.context.__code
              : error instanceof TransactionNotSubmittedError
                ? 'submission_refused'
                : 'submission_unknown',
          }),
        )
        // A checked refusal is definitive only on the first submission attempt.
        if (error instanceof TransactionNotSubmittedError && acceptedHere) {
          await persistObservation(
            env.DB,
            id,
            extracted,
            { status: 'failed', receipt: null },
            options.now ?? Date.now(),
            'submission_refused',
          )
          return snapshot()
        }
        // A lost response may follow a successful broadcast. Observe the signature.
      }
    }
    const observed = await observeSubmission(rpc, extracted, {
      ...options.observation,
      lastValidBlockHeight: candidate.lastValidBlockHeight,
    })
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
