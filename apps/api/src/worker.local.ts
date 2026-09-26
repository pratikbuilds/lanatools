import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { createApp } from './app'
import { dbSmoke } from './db/schema'

const app = createApp<{ DB: D1Database }>()

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
