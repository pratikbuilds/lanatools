import { createMiddleware } from 'hono/factory'
import { HTTPException } from 'hono/http-exception'
import { verifyPrivyToken } from '../mcp-service'
import type { McpEnv } from '../mcp-service'

/** Requires a Privy access token and exposes its user as `userId`. */
export const privyAuth = createMiddleware<{
  Bindings: McpEnv
  Variables: { userId: string }
}>(async (c, next) => {
  const token = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1]
  if (!token) throw new HTTPException(401)
  const userId = await verifyPrivyToken(c.env, token).catch(() => {
    throw new HTTPException(401)
  })
  c.set('userId', userId)
  await next()
})
