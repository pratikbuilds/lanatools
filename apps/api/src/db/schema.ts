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

export const mcpConsent = sqliteTable('mcp_consent', {
  handle: text('handle').primaryKey(),
  clientId: text('client_id').notNull(),
  clientName: text('client_name').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  // Space-separated OAuth scopes, as in the authorization request.
  scope: text('scope').notNull().default('account:read'),
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
    // Space-separated OAuth scopes the user approved.
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
 * One row per pay_http call. Request and response bodies are never stored.
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
  ],
)
