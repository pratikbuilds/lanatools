import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { type } from 'arktype'
import { isAddress } from '@solana/kit'
import { PhoenixCandleInterval } from '@lanatools/contracts'
import type { PhoenixAccount } from '@lanatools/contracts'
import { readPhoenixAccount } from '@lanatools/phoenix'
import type { PhoenixOpts } from '@lanatools/phoenix'
import type { McpEnv } from '../mcp-service'
import {
  PhoenixReadError,
  phoenixCandles,
  phoenixFills,
} from '../phoenix/dashboard'

/** Phoenix's answer, or a 400 for a bad request and a 502 for anything else. */
async function answer<T>(read: () => Promise<T>) {
  try {
    return await read()
  } catch (error) {
    if (error instanceof PhoenixReadError && error.code === 'invalid_input')
      throw new HTTPException(400)
    throw new HTTPException(502)
  }
}

/**
 * A wallet's Phoenix account, a market's candles and a wallet's fills.
 * Phoenix is mainnet only and needs no key. Fills name the client that
 * placed them only for a signed-in viewer's own transactions.
 */
export function phoenixReads(opts: PhoenixOpts) {
  return new Hono<{ Bindings: McpEnv; Variables: { userId?: string } }>()
    .get('/account/:address', async (c) => {
      const wallet = c.req.param('address')
      if (!isAddress(wallet)) throw new HTTPException(400)
      return c.json(
        (await answer(() =>
          readPhoenixAccount(wallet, opts),
        )) satisfies PhoenixAccount,
      )
    })
    .get('/candles/:symbol', async (c) => {
      const interval = PhoenixCandleInterval(c.req.query('interval') ?? '1d')
      if (interval instanceof type.errors) throw new HTTPException(400)
      return c.json(
        await answer(() =>
          phoenixCandles(c.req.param('symbol'), interval, opts),
        ),
      )
    })
    .get('/fills/:address', async (c) => {
      const wallet = c.req.param('address')
      if (!isAddress(wallet)) throw new HTTPException(400)
      return c.json(
        await answer(() =>
          phoenixFills(
            c.env.DB,
            c.get('userId') ?? null,
            wallet,
            c.req.query('cursor'),
            opts,
          ),
        ),
      )
    })
}

export type PublicPhoenixEnv = McpEnv & { PHOENIX_PUBLIC_LIMITER: RateLimit }

/**
 * The same reads for the public account page. Phoenix's data is public, so
 * there is no login; the limit protects our calls to Phoenix, per visitor.
 */
export function publicPhoenixRoutes(opts: PhoenixOpts = {}) {
  return new Hono<{ Bindings: PublicPhoenixEnv }>()
    .use(async (c, next) => {
      const { success } = await c.env.PHOENIX_PUBLIC_LIMITER.limit({
        key: `lanatools:phoenix-public:${c.req.header('CF-Connecting-IP') ?? 'local'}`,
      })
      if (!success) {
        c.header('Retry-After', '60')
        throw new HTTPException(429)
      }
      await next()
    })
    .route('/', phoenixReads(opts))
}
