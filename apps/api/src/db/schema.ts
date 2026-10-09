import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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
      // `uncertain` is only left by Workers from before migration 0011.
      enum: ['free', 'refused', 'reserved', 'paid', 'failed', 'uncertain'],
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
