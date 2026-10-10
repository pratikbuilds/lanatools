import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { PaymentSignerRequest } from '@lanatools/contracts'
import type {
  PaymentSignerGrant,
  PaymentSignerRefusal,
  PaymentSignerStatus,
} from '@lanatools/contracts'
import { privyClient } from '../mcp-service'
import type { McpEnv } from '../mcp-service'
import { paymentConfig } from '../solana/network'
import {
  SignerNotAttachedError,
  SignerSetupError,
  confirmSigner,
  disableSigner,
  prepareSigner,
  signerStatus,
} from '../payments/signer-setup'
import { privyAuth } from './privy-auth'

/** The dashboard's controls for the LanaTools server signer. */
export const paymentSignerRoutes = new Hono<{
  Bindings: McpEnv
  Variables: { userId: string }
}>()
  .use(privyAuth)
  .get('/', async (c) =>
    c.json(
      (await signerStatus(
        c.env.DB,
        c.get('userId'),
        Boolean(c.env.PRIVY_TRANSACTION_SIGNER_ID),
        c.env.PRIVY_TRANSACTION_SIGNER_ID ? privyClient(c.env) : undefined,
      )) satisfies PaymentSignerStatus,
    ),
  )
  .post('/prepare', async (c) => {
    const body = PaymentSignerRequest(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    const { network } = await paymentConfig(c.env)
    try {
      const grant = await prepareSigner(c.env.DB, privyClient(c.env), {
        userId: c.get('userId'),
        walletAddress: body.walletAddress,
        signerId: c.env.PRIVY_PAYMENT_SIGNER_ID,
        transactionSignerId: c.env.PRIVY_TRANSACTION_SIGNER_ID || undefined,
        network,
        restore: body.restore ?? false,
      })
      return c.json(grant satisfies PaymentSignerGrant)
    } catch (error) {
      if (error instanceof SignerSetupError)
        return c.json({ error: error.message }, 409)
      throw error
    }
  })
  .post('/confirm', async (c) => {
    try {
      const status = await confirmSigner(
        c.env.DB,
        privyClient(c.env),
        c.get('userId'),
        c.env.PRIVY_PAYMENT_SIGNER_ID,
        c.env.PRIVY_TRANSACTION_SIGNER_ID || undefined,
      )
      return c.json(status satisfies PaymentSignerStatus)
    } catch (error) {
      if (error instanceof SignerSetupError)
        return c.json(
          (error instanceof SignerNotAttachedError
            ? { error: error.message, code: 'signer-not-attached' }
            : { error: error.message }) satisfies PaymentSignerRefusal,
          409,
        )
      throw error
    }
  })
  .post('/disable', async (c) =>
    c.json(
      (await disableSigner(
        c.env.DB,
        c.get('userId'),
      )) satisfies PaymentSignerStatus,
    ),
  )
