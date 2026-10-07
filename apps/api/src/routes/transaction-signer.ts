import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { TransactionSignerRequest } from '@lanatools/contracts'
import { privyClient } from '../mcp-service'
import type { McpEnv } from '../mcp-service'
import { SignerSetupError } from '../payments/signer-setup'
import {
  confirmSigner,
  disableSigner,
  prepareSigner,
  signerStatus,
} from '../transactions/signer-setup'
import type { TransactionSignerClient } from '../transactions/signer-setup'
import { privyAuth } from './privy-auth'

export function createTransactionSignerRoutes(
  authenticate: typeof privyAuth = privyAuth,
  client: (env: McpEnv) => TransactionSignerClient = (env) =>
    privyClient(env, { maxRetries: 0, timeout: 10_000 }),
) {
  return new Hono<{
    Bindings: McpEnv
    Variables: { userId: string }
  }>()
    .use(authenticate)
    .get('/', async (c) => c.json(await signerStatus(c.env, c.get('userId'))))
    .post('/:operation', async (c) => {
      const operation = c.req.param('operation')
      if (!['prepare', 'confirm', 'disable'].includes(operation))
        throw new HTTPException(404)
      const body = TransactionSignerRequest(
        await c.req.json().catch(() => null),
      )
      if (body instanceof type.errors) throw new HTTPException(400)
      const input = {
        userId: c.get('userId'),
        walletAddress: body.walletAddress,
      }
      try {
        const privy = client(c.env)
        if (operation === 'prepare')
          return c.json(await prepareSigner(c.env, privy, input))
        if (operation === 'confirm')
          return c.json(await confirmSigner(c.env, privy, input))
        // privyAuth verified this exact bearer token before this handler ran.
        const userAccessToken = /^Bearer (.+)$/.exec(
          c.req.header('authorization') ?? '',
        )?.[1]
        if (!userAccessToken) throw new HTTPException(401)
        return c.json(
          await disableSigner(c.env, privy, { ...input, userAccessToken }),
        )
      } catch (error) {
        if (error instanceof SignerSetupError)
          return c.json({ error: error.message }, 409)
        return c.json(
          {
            error:
              'Transaction signer operation could not be completed. Refresh and try again.',
          },
          409,
        )
      }
    })
}

export const transactionSignerRoutes = createTransactionSignerRoutes()
