import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  ClientLimitUpdate,
  ClientOutgoingUpdate,
  parseClientLimit,
} from '@lanatools/contracts'
import type { McpClientList } from '@lanatools/contracts'
import { listClients, setClientLimit, setClientOutgoing } from '../mcp-grants'
import { revokeClient } from '../mcp-service'
import type { McpDashboardEnv } from '../mcp-service'
import { privyAuth } from './privy-auth'

export const mcpClients = new Hono<{
  Bindings: McpDashboardEnv
  Variables: { userId: string }
}>()
  .use(privyAuth)
  .get('/', async (c) => {
    const clients = await listClients(c.env.DB, c.get('userId'))
    return c.json({ clients } satisfies McpClientList)
  })
  .post('/:grantId/revoke', async (c) => {
    const revoked = await revokeClient(
      c.env,
      c.get('userId'),
      c.req.param('grantId'),
    )
    if (!revoked) throw new HTTPException(404)
    return c.body(null, 204)
  })
  .put('/:grantId/limit', async (c) => {
    const body = ClientLimitUpdate(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    const limit = parseClientLimit(body.limitUsd)
    if (limit === null) throw new HTTPException(400)
    const updated = await setClientLimit(
      c.env.DB,
      c.get('userId'),
      c.req.param('grantId'),
      limit,
    )
    if (!updated) throw new HTTPException(404)
    return c.body(null, 204)
  })

  .put('/:grantId/outgoing', async (c) => {
    const body = ClientOutgoingUpdate(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    const updated = await setClientOutgoing(
      c.env.DB,
      c.get('userId'),
      c.req.param('grantId'),
      body.allowed,
    )
    if (!updated) throw new HTTPException(404)
    return c.body(null, 204)
  })
