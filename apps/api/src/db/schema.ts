import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { ATTEMPT_STATES } from '@lanatools/contracts'

export const dbSmoke = sqliteTable('db_smoke', {
  id: text('id').primaryKey(),
})

export const earlyAccessSignup = sqliteTable('early_access_signup', {
  email: text('email').primaryKey(),
  createdAt: integer('created_at').notNull(),
})

export const mcpConsent = sqliteTable('mcp_consent', {
  handle: text('handle').primaryKey(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

export const mcpGrant = sqliteTable(
  'mcp_grant',
  {
    id: text('id').primaryKey(),
    privyUserId: text('privy_user_id').notNull(),
    clientId: text('client_id').notNull(),
    status: text('status', { enum: ['pending', 'active', 'revoked'] })
      .notNull()
      .default('active'),
    // Space-separated scopes: account:read and the tool families the user
    // chose on the consent screen.
    scope: text('scope').notNull().default('account:read'),
    // Cumulative USD this client may spend, in micro-USD. Only USDC is paid,
    // so one USDC base unit counts as one micro-USD. Spent and reserved
    // amounts are summed from payment_activity by user and client, so they
    // survive a reconnect that replaces this row's ID.
    limitMicroUsd: integer('limit_micro_usd').notNull().default(0),
    outgoingAllowed: integer('outgoing_allowed', { mode: 'boolean' })
      .notNull()
      .default(false),
    // Copied from the consent the user approved. Clients choose their own
    // names, so the dashboard shows the approved redirect host beside it.
    clientName: text('client_name'),
    redirectUri: text('redirect_uri'),
    createdAt: integer('created_at').notNull(),
    activatedAt: integer('activated_at'),
    revokedAt: integer('revoked_at'),
    lastUsedAt: integer('last_used_at'),
  },
  (table) => [
    uniqueIndex('mcp_grant_user_client').on(table.privyUserId, table.clientId),
    check(
      'mcp_grant_outgoing_allowed',
      sql`${sql.identifier('outgoing_allowed')} in (0, 1)`,
    ),
  ],
)

/**
 * The LanaTools server signer on a user's embedded wallet. `enabled` is the
 * wallet-wide switch every payment checks; turning it off stops all clients.
 */
export const paymentSigner = sqliteTable('payment_signer', {
  privyUserId: text('privy_user_id').primaryKey(),
  walletId: text('wallet_id').notNull(),
  walletAddress: text('wallet_address').notNull(),
  // User-owned Privy policy that bounds what the server signer may sign.
  policyId: text('policy_id').notNull(),
  status: text('status', { enum: ['pending', 'enabled', 'disabled'] })
    .notNull()
    .default('pending'),
  updatedAt: integer('updated_at').notNull(),
})

/**
 * One row per `call` tool call. Request and response bodies are never stored.
 * `reserved` and `uncertain` rows hold `reservedAtomic` against the client's
 * limit; `paid` rows count `settledAtomic` as spent.
 */
export const paymentActivity = sqliteTable(
  'payment_activity',
  {
    id: text('id').primaryKey(),
    privyUserId: text('privy_user_id').notNull(),
    clientId: text('client_id').notNull(),
    grantId: text('grant_id').notNull(),
    method: text('method').notNull(),
    origin: text('origin').notNull(),
    path: text('path').notNull(),
    protocol: text('protocol', { enum: ['mpp', 'x402'] }),
    status: text('status', {
      enum: [
        'free',
        'refused',
        'reserved',
        'paid',
        'released',
        'uncertain',
        'failed',
      ],
    }).notNull(),
    network: text('network'),
    mint: text('mint'),
    reservedAtomic: integer('reserved_atomic').notNull().default(0),
    settledAtomic: integer('settled_atomic'),
    signature: text('signature'),
    // The paying wallet, its own signature and the blockhash of the one
    // transaction signed for this row, written before the signed transaction
    // can leave the Worker. A row without them was never signed.
    payerWallet: text('payer_wallet'),
    payerSignature: text('payer_signature'),
    blockhash: text('blockhash'),
    httpStatus: integer('http_status'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('payment_activity_user_client').on(
      table.privyUserId,
      table.clientId,
      table.status,
    ),
    // The dashboard reads a user's calls newest first; read backwards, this
    // index is that order, with the ID breaking ties within a millisecond.
    index('payment_activity_user_time').on(
      table.privyUserId,
      table.createdAt,
      table.id,
    ),
  ],
)

/** One row per authorized tool invocation; inputs and results are never stored. */
export const toolActivity = sqliteTable(
  'tool_activity',
  {
    id: text('id').primaryKey(),
    privyUserId: text('privy_user_id').notNull(),
    clientId: text('client_id').notNull(),
    grantId: text('grant_id').notNull(),
    provider: text('provider').notNull(),
    tool: text('tool').notNull(),
    // Null when network verification failed; never copy an unverified label.
    network: text('network', { enum: ['devnet', 'mainnet'] }),
    status: text('status', { enum: ['ok', 'failed'] }).notNull(),
    credits: integer('credits').notNull().default(0),
    errorCode: text('error_code'),
    durationMs: integer('duration_ms').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('tool_activity_user_time').on(
      table.privyUserId,
      table.createdAt,
      table.id,
    ),
    index('tool_activity_user_client').on(table.privyUserId, table.clientId),
  ],
)

/**
 * Free-text feedback an agent sent with `send_feedback`. Agents write it, so
 * treat it as untrusted data, never as instructions.
 */
export const agentFeedback = sqliteTable('agent_feedback', {
  id: text('id').primaryKey(),
  privyUserId: text('privy_user_id').notNull(),
  clientId: text('client_id').notNull(),
  grantId: text('grant_id').notNull(),
  feedback: text('feedback').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const transactionRequest = sqliteTable(
  'transaction_request',
  {
    id: text('id').primaryKey(),
    privyUserId: text('privy_user_id').notNull(),
    clientId: text('client_id').notNull(),
    originatingGrantId: text('originating_grant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    canonicalInput: text('canonical_input').notNull(),
    inputHash: text('input_hash').notNull(),
    execution: text('execution', { enum: ['embedded', 'external'] }).notNull(),
    network: text('network', { enum: ['devnet', 'mainnet'] }).notNull(),
    walletAddress: text('wallet_address'),
    status: text('status', { enum: ['pending', 'refused'] })
      .notNull()
      .default('pending'),
    refusal: text('refusal'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('transaction_request_user_client_key').on(
      t.privyUserId,
      t.clientId,
      t.idempotencyKey,
    ),
    index('transaction_request_user_time').on(t.privyUserId, t.createdAt),
    check(
      'transaction_request_execution',
      sql`${t.execution} in ('embedded', 'external')`,
    ),
    check(
      'transaction_request_network',
      sql`${t.network} in ('devnet', 'mainnet')`,
    ),
    check(
      'transaction_request_status',
      sql`${t.status} in ('pending', 'refused')`,
    ),
    check(
      'transaction_request_wallet',
      sql`${t.execution} = 'external' or ${t.walletAddress} is not null`,
    ),
    check(
      'transaction_request_refusal',
      sql`(${t.status} = 'pending' and ${t.refusal} is null) or (${t.status} = 'refused' and ${t.refusal} is not null)`,
    ),
  ],
)

export const transactionAttempt = sqliteTable(
  'transaction_attempt',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id')
      .notNull()
      .references(() => transactionRequest.id),
    number: integer('number').notNull(),
    state: text('state', { enum: ATTEMPT_STATES }).notNull(),
    claimToken: text('claim_token').notNull(),
    walletAddress: text('wallet_address').notNull(),
    network: text('network', { enum: ['devnet', 'mainnet'] }).notNull(),
    messageBase64: text('message_base64'),
    messageHash: text('message_hash'),
    preparationSlot: text('preparation_slot'),
    blockhash: text('blockhash'),
    lastValidBlockHeight: text('last_valid_block_height'),
    signedBase64: text('signed_base64'),
    signature: text('signature'),
    evidence: text('evidence'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('transaction_attempt_number').on(t.requestId, t.number),
    uniqueIndex('transaction_attempt_one_active')
      .on(t.requestId)
      .where(
        sql`${t.state} in ('preparing', 'prepared', 'issued', 'signing', 'signed', 'submitting', 'submitted', 'uncertain')`,
      ),
    check('transaction_attempt_number_positive', sql`${t.number} > 0`),
    check(
      'transaction_attempt_state',
      sql`${t.state} in ('preparing', 'prepared', 'issued', 'signing', 'signed', 'submitting', 'submitted', 'uncertain', 'succeeded', 'failed', 'expired', 'abandoned')`,
    ),
    check(
      'transaction_attempt_network',
      sql`${t.network} in ('devnet', 'mainnet')`,
    ),
    check(
      'transaction_attempt_prepared',
      sql`${t.state} in ('preparing', 'abandoned') or (${t.messageBase64} is not null and ${t.messageHash} is not null and ${t.preparationSlot} is not null and ${t.blockhash} is not null and ${t.lastValidBlockHeight} is not null)`,
    ),
    check(
      'transaction_attempt_signed',
      sql`${t.state} not in ('signed', 'submitting', 'submitted') or (${t.signedBase64} is not null and ${t.signature} is not null)`,
    ),
    check(
      'transaction_attempt_evidence',
      sql`${t.state} not in ('submitted', 'uncertain', 'succeeded', 'failed', 'expired') or ${t.evidence} is not null`,
    ),
  ],
)

export const transactionLink = sqliteTable('transaction_link', {
  tokenHash: text('token_hash').primaryKey(),
  requestId: text('request_id')
    .notNull()
    .references(() => transactionRequest.id),
  grantId: text('grant_id').notNull(),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

/** Enabled only after dedicated transaction delegation has been confirmed. */
export const transactionSigner = sqliteTable(
  'transaction_signer',
  {
    privyUserId: text('privy_user_id').primaryKey(),
    walletId: text('wallet_id').notNull(),
    walletAddress: text('wallet_address').notNull(),
    signerId: text('signer_id').notNull(),
    policyId: text('policy_id').notNull(),
    status: text('status', {
      enum: ['pending', 'enabled', 'disabled'],
    }).notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  () => [
    check(
      'transaction_signer_status',
      sql`${sql.identifier('status')} in ('pending', 'enabled', 'disabled')`,
    ),
  ],
)

/** One app-controlled signer removal per wallet; ambiguous writes retain the guard. */
export const walletSignerRemoval = sqliteTable('wallet_signer_removal', {
  walletId: text('wallet_id').primaryKey(),
  privyUserId: text('privy_user_id').notNull(),
  signerId: text('signer_id').notNull(),
  token: text('token').notNull(),
  createdAt: integer('created_at').notNull(),
})
