import { Hono } from 'hono'
import { type } from 'arktype'
import { bodyLimit } from 'hono/body-limit'
import {
  ExternalLinkError,
  prepareExternalLink,
  reviewExternalLink,
  submitExternalLink,
} from '../transactions/external-link'
import type {
  ExternalLinkDependencies,
  ExternalLinkEnv,
} from '../transactions/external-link'
import { TransactionConflict } from '../transactions/ledger'

const Wallet = type({ '+': 'reject', walletAddress: '32 <= string <= 44' })
const Signed = type({ '+': 'reject', signedBase64: '1 <= string <= 1644' })

export function createTransactionLinkRoutes(
  deps: ExternalLinkDependencies = {},
) {
  return new Hono<{ Bindings: ExternalLinkEnv }>()
    .onError((error, c) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      if (error instanceof ExternalLinkError)
        return c.json({ error: error.message }, error.status)
      if (error instanceof TransactionConflict)
        return c.json({ error: 'Transfer changed or is unavailable' }, 409)
      return c.json(
        { error: 'Could not complete this transfer operation' },
        502,
      )
    })
    .use('*', async (c, next) => {
      c.header('Cache-Control', 'no-store')
      c.header('Referrer-Policy', 'no-referrer')
      await next()
    })
    .use(
      '*',
      bodyLimit({
        maxSize: 2048,
        onError: (c) => c.json({ error: 'Transfer input is too large' }, 413),
      }),
    )
    .get('/', async (c) =>
      c.json(
        await reviewExternalLink(
          c.env,
          token(c.req.header('Authorization')),
          deps,
        ),
      ),
    )
    .post('/prepare', async (c) => {
      const body = Wallet(await readBody(c.req.raw))
      if (body instanceof type.errors)
        return c.json({ error: 'Invalid wallet selection' }, 400)
      return c.json(
        await prepareExternalLink(
          c.env,
          token(c.req.header('Authorization')),
          body.walletAddress,
          deps,
        ),
      )
    })
    .post('/submit', async (c) => {
      const body = Signed(await readBody(c.req.raw))
      if (body instanceof type.errors)
        return c.json({ error: 'Invalid signed transaction' }, 400)
      return c.json(
        await submitExternalLink(
          c.env,
          token(c.req.header('Authorization')),
          body.signedBase64,
          deps,
        ),
      )
    })
}
function token(authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer '))
    throw new ExternalLinkError(403, 'Transfer link is unavailable or expired')
  return authorization.slice(7)
}
async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ExternalLinkError(400, 'Invalid transfer input')
  }
}
export const transactionLinkRoutes = createTransactionLinkRoutes()
