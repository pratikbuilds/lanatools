import { type } from 'arktype'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { EarlyAccessRequest } from '@lanatools/contracts'
import type { EarlyAccessResponse } from '@lanatools/contracts'
import type { D1Database, RateLimit } from '@cloudflare/workers-types'
import { earlyAccessSignup } from '../db/schema'

export type EarlyAccessEnv = { DB: D1Database; SIGNUP_LIMITER: RateLimit }

export const earlyAccess = new Hono<{ Bindings: EarlyAccessEnv }>()
  .use(bodyLimit({ maxSize: 4096 }))
  .post('/', async (c) => {
    const { success } = await c.env.SIGNUP_LIMITER.limit({
      key: `lanatools:early-access:${c.req.header('CF-Connecting-IP') ?? 'local'}`,
    })
    if (!success) {
      c.header('Retry-After', '60')
      throw new HTTPException(429)
    }
    const body = EarlyAccessRequest(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    await drizzle(c.env.DB)
      .insert(earlyAccessSignup)
      .values({ email: body.email, createdAt: Date.now() })
      .onConflictDoNothing({ target: earlyAccessSignup.email })
      .run()
      .catch(() => {
        // Drizzle errors include query parameters. Keep emails out of logs.
        throw new HTTPException(503, { message: 'Could not save signup' })
      })
    return c.json({
      status: 'joined',
      email: body.email,
    } satisfies EarlyAccessResponse)
  })
