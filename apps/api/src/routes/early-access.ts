import { type } from 'arktype'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { EarlyAccessRequest } from '@lanatools/contracts'
import type { EarlyAccessResponse } from '@lanatools/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { earlyAccessSignup } from '../db/schema'

export const earlyAccess = new Hono<{ Bindings: { DB: D1Database } }>()
  .use(bodyLimit({ maxSize: 4096 }))
  .post('/', async (c) => {
    const body = EarlyAccessRequest(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    const saved = await drizzle(c.env.DB)
      .insert(earlyAccessSignup)
      .values({ email: body.email, createdAt: Date.now() })
      .onConflictDoNothing({ target: earlyAccessSignup.email })
      .returning({ email: earlyAccessSignup.email })
      .all()
      .catch(() => {
        // Drizzle errors include query parameters. Keep emails out of logs.
        throw new HTTPException(503, { message: 'Could not save signup' })
      })
    return c.json({
      status: saved.length > 0 ? 'saved' : 'already-present',
      email: body.email,
    } satisfies EarlyAccessResponse)
  })
