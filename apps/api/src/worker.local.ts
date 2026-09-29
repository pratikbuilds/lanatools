import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { createApp } from './app'
import { dbSmoke } from './db/schema'
import type { McpDashboardEnv } from './mcp-service'
import { mcpClients } from './routes/mcp-clients'
import { paymentSignerRoutes } from './routes/payment-signer'

export { McpAccessService } from './mcp-service'

const app = createApp<McpDashboardEnv>()
app.route('/api/mcp/clients', mcpClients)
app.route('/api/payments/signer', paymentSignerRoutes)

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
