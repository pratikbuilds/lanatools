import { Hono } from 'hono'
import type { PhoenixOpts } from '@lanatools/phoenix'
import type { McpEnv } from '../mcp-service'
import { phoenixReads } from './phoenix-public'
import { privyAuth } from './privy-auth'

/** The dashboard's Phoenix account page. */
export function phoenixRoutes(opts: PhoenixOpts = {}) {
  return new Hono<{ Bindings: McpEnv; Variables: { userId: string } }>()
    .use(privyAuth)
    .route('/', phoenixReads(opts))
}
