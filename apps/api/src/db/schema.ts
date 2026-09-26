import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const dbSmoke = sqliteTable('db_smoke', {
  id: text('id').primaryKey(),
})
