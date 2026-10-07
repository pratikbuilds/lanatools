import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  PaymentSignerRequest,
  TransactionSignerRequest,
} from '@lanatools/contracts'
import type {
  PaymentSignerGrant,
  PaymentSignerStatus,
} from '@lanatools/contracts'
import { privyClient } from '../mcp-service'
import type { McpEnv } from '../mcp-service'
import { paymentConfig } from '../solana/network'
import {
  SignerSetupError,
  confirmSigner,
  disableSigner,
  prepareSigner,
  signerStatus,
} from '../payments/signer-setup'
import { privyAuth } from './privy-auth'
import { disablePaymentDelegation } from '../payments/signer-removal'

/** The dashboard's controls for the LanaTools server signer. */
export function createPaymentSignerRoutes(
  authenticate: typeof privyAuth = privyAuth,
) {
  return new Hono<{
    Bindings: McpEnv
    Variables: { userId: string }
  }>()
    .use(authenticate)
    .get('/', async (c) =>
      c.json(
        (await signerStatus(
          c.env.DB,
          c.get('userId'),
        )) satisfies PaymentSignerStatus,
      ),
    )
    .post('/prepare', async (c) => {
      const body = PaymentSignerRequest(await c.req.json().catch(() => null))
      if (body instanceof type.errors) throw new HTTPException(400)
      const { network } = await paymentConfig(c.env)
      try {
        const grant = await prepareSigner(
          c.env.DB,
          privyClient(c.env, { maxRetries: 0, timeout: 10_000 }),
          {
            userId: c.get('userId'),
            walletAddress: body.walletAddress,
            signerId: c.env.PRIVY_PAYMENT_SIGNER_ID,
            network,
          },
        )
        return c.json(grant satisfies PaymentSignerGrant)
      } catch (error) {
        if (error instanceof SignerSetupError)
          return c.json({ error: error.message }, 409)
        return c.json(
          {
            error:
              'Payment delegation could not be completed. Refresh; turn off pending setup before retrying.',
          },
          409,
        )
      }
    })
    .post('/confirm', async (c) => {
      try {
        const status = await confirmSigner(
          c.env.DB,
          privyClient(c.env, { maxRetries: 0, timeout: 10_000 }),
          c.get('userId'),
          c.env.PRIVY_PAYMENT_SIGNER_ID,
        )
        return c.json(status satisfies PaymentSignerStatus)
      } catch (error) {
        if (error instanceof SignerSetupError)
          return c.json({ error: error.message }, 409)
        return c.json(
          {
            error:
              'Payment delegation could not be completed. Refresh; turn off pending setup before retrying.',
          },
          409,
        )
      }
    })
    .post('/disable', async (c) => {
      const rawBody = await c.req.text()
      if (!rawBody.trim()) {
        await disableSigner(c.env.DB, c.get('userId'))
        return c.json(
          {
            error:
              'Payments are off. Refresh the dashboard to remove only the payment signer.',
          },
          409,
        )
      }
      let payload: unknown
      try {
        payload = JSON.parse(rawBody)
      } catch {
        throw new HTTPException(400)
      }
      const body = TransactionSignerRequest(payload)
      if (body instanceof type.errors) throw new HTTPException(400)
      const token = /^Bearer (.+)$/.exec(
        c.req.header('authorization') ?? '',
      )?.[1]
      if (!token) throw new HTTPException(401)
      try {
        return c.json(
          await disablePaymentDelegation(
            c.env.DB,
            privyClient(c.env, { maxRetries: 0, timeout: 10_000 }),
            {
              userId: c.get('userId'),
              walletAddress: body.walletAddress,
              signerId: c.env.PRIVY_PAYMENT_SIGNER_ID,
              userAccessToken: token,
            },
          ),
        )
      } catch (error) {
        if (error instanceof SignerSetupError)
          return c.json({ error: error.message }, 409)
        return c.json(
          {
            error:
              'Payment delegation could not be completed. Refresh; turn off pending setup before retrying.',
          },
          409,
        )
      }
    })
}

export const paymentSignerRoutes = createPaymentSignerRoutes()
