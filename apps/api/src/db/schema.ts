import {
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
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('mcp_grant_user_client').on(table.privyUserId, table.clientId),
  ],
)
