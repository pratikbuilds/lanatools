import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import app from './worker'
import { dbSmoke } from './db/schema'

export { McpAccessService } from './mcp-service'

// The deployed Worker's routes, plus the database smoke routes that only the
// local Worker serves.
app.post('/api/db-smoke', async (c) => {
  const id = crypto.randomUUID()
  const db = drizzle(c.env.DB)
  await db.insert(dbSmoke).values({ id })
  const row = await db.select().from(dbSmoke).where(eq(dbSmoke.id, id)).get()
  return c.json({ id: row?.id })
})

app.get('/api/db-smoke/:id', async (c) => {
  const db = drizzle(c.env.DB)
  const row = await db
    .select()
    .from(dbSmoke)
    .where(eq(dbSmoke.id, c.req.param('id')))
    .get()
  return row ? c.json(row) : c.notFound()
})

export default app
