import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ActivityQuery } from '@lanatools/contracts'
import type { ActivityDays, ActivityPage } from '@lanatools/contracts'
import type { McpEnv } from '../mcp-service'
import {
  ACTIVITY_PAGE_SIZE,
  activityDays,
  listActivity,
  parseActivityCursor,
} from '../payments/activity'
import { privyAuth } from './privy-auth'

/** The dashboard's read of the signed-in user's recorded calls. */
export const activity = new Hono<{
  Bindings: McpEnv
  Variables: { userId: string }
}>()
  .use(privyAuth)
  .get('/', async (c) => {
    const query = ActivityQuery(c.req.query())
    if (query instanceof type.errors) throw new HTTPException(400)
    const before =
      query.before === undefined ? undefined : parseActivityCursor(query.before)
    if (before === null) throw new HTTPException(400)
    const page = await listActivity(c.env.DB, c.get('userId'), {
      clientId: query.client,
      outcome: query.outcome,
      before,
      limit: ACTIVITY_PAGE_SIZE,
    })
    return c.json(page satisfies ActivityPage)
  })
  .get('/days', async (c) => {
    const days = await activityDays(c.env.DB, c.get('userId'))
    return c.json({ days } satisfies ActivityDays)
  })
