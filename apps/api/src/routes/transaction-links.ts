import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { bodyLimit } from 'hono/body-limit'
import type { RateLimit } from '@cloudflare/workers-types'
import {
  observeTransactionLink,
  prepareTransactionLink,
  sendTransactionLink,
} from '../transactions/requests'
import type {
  ExecutionOptions,
  TransactionExecutionEnv,
} from '../transactions/requests'

export type TransactionLinksEnv = TransactionExecutionEnv & {
  TRANSACTION_LINK_LIMITER: RateLimit
}

function errorStatus(code: string) {
  if (code === 'invalid_input') return 400
  if (code === 'not_found') return 404
  if (
    code === 'conflict' ||
    code === 'preparing' ||
    code === 'closed' ||
    code === 'transaction_expired'
  )
    return 409
  return 503
}

const invalidInput = {
  error: {
    code: 'invalid_input',
    message: 'Invalid transaction request.',
    retryable: false,
  },
}

export const createTransactionLinks = (options: ExecutionOptions = {}) =>
  new Hono<{ Bindings: TransactionLinksEnv }>()
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      const { success } = await c.env.TRANSACTION_LINK_LIMITER.limit({
        key: `lanatools:transaction-link:${c.req.header('CF-Connecting-IP') ?? 'local'}`,
      })
      if (!success) {
        c.header('Retry-After', '60')
        return c.json(
          {
            error: {
              code: 'rate_limited',
              message: 'Too many requests. Try again shortly.',
              retryable: true,
            },
          },
          429,
        )
      }
      return next()
    })
    .use(
      '*',
      bodyLimit({ maxSize: 4096, onError: (c) => c.json(invalidInput, 413) }),
    )
    .get('/:id', async (c) => {
      const link = await observeTransactionLink(
        c.env,
        c.req.param('id'),
        options,
      ).catch(() => {
        throw new HTTPException(503, {
          message: 'Could not read transaction link',
        })
      })
      if (!link) throw new HTTPException(404)
      return c.json(link)
    })
    .post('/:id/transaction', async (c) => {
      const input: unknown = await c.req.json().catch(() => null)
      const outcome = await prepareTransactionLink(
        c.env,
        c.req.param('id'),
        input,
        options,
      )
      return outcome.ok
        ? c.json(outcome.result)
        : c.json({ error: outcome.error }, errorStatus(outcome.error.code))
    })
    .post('/:id/send', async (c) => {
      const input: unknown = await c.req.json().catch(() => null)
      const outcome = await sendTransactionLink(
        c.env,
        c.req.param('id'),
        input,
        options,
      )
      return outcome.ok
        ? c.json(outcome.result)
        : c.json({ error: outcome.error }, errorStatus(outcome.error.code))
    })

export const transactionLinks = createTransactionLinks()
