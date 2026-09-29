import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { McpClientList } from '@lanatools/contracts'
import { listClients } from '../mcp-grants'
import { revokeClient, verifyPrivyToken } from '../mcp-service'
import type { McpDashboardEnv } from '../mcp-service'

export const mcpClients = new Hono<{
  Bindings: McpDashboardEnv
  Variables: { userId: string }
}>()
  .use(async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1]
    if (!token) throw new HTTPException(401)
    const userId = await verifyPrivyToken(c.env, token).catch(() => {
      throw new HTTPException(401)
    })
    c.set('userId', userId)
    await next()
  })
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
