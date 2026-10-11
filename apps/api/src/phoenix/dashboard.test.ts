import { afterAll, beforeAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type { PhoenixFetch } from '@lanatools/phoenix'
import { mcpGrant, transactionRequest } from '../db/schema'
import { testDatabase } from '../test-database'
import { phoenixCandles, phoenixFills } from './dashboard'

const WALLET = 'TEY5zgBjT247DQ5n9EiHrLmHW6TZmxRFRqLqGf4FQNQ'
const MINE = '5'.repeat(87)
const THEIRS = '6'.repeat(87)
const NOON = Date.UTC(2026, 9, 11, 12)

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

function fakeFetch(routes: Record<string, unknown>) {
  const asked: URL[] = []
  const fetch: PhoenixFetch = async (url) => {
    const parsed = new URL(url)
    asked.push(parsed)
    const body = routes[parsed.pathname]
    return body === undefined
      ? Response.json({ error: 'not found' }, { status: 404 })
      : Response.json(body)
  }
  return { fetch, asked }
}

async function placed(user: string, signature: string, clientName: string) {
  const grantId = crypto.randomUUID()
  await drizzle(db)
    .insert(mcpGrant)
    .values({
      id: grantId,
      privyUserId: user,
      clientId: `client-${grantId}`,
      clientName,
      status: 'active',
      scope: 'phoenix:trade',
      createdAt: NOON,
    })
  await drizzle(db)
    .insert(transactionRequest)
    .values({
      id: crypto.randomUUID(),
      toolName: 'phoenix_market_order',
      argumentsJson: '{}',
      network: 'mainnet',
      creatorUserId: user,
      creatorClientId: `client-${grantId}`,
      creatorGrantId: grantId,
      idempotencyKey: crypto.randomUUID(),
      delivery: 'embedded',
      status: 'confirmed',
      signature,
      account: WALLET,
      createdAt: NOON,
      updatedAt: NOON,
      expiresAt: NOON,
    })
}

const trade = (signature: string | null, price: number) => ({
  marketSymbol: 'SOL',
  subaccountIndex: 0,
  timestamp: '2026-10-11T09:20:26Z',
  baseLotsDelta: '0.1',
  price: String(price),
  realizedPnl: '0',
  fees: '0.0038',
  liquidity: 'taker',
  tradeType: 'market',
  signature,
})

test('fills name the client that placed them, for the signed-in user only', async () => {
  const user = `user-${crypto.randomUUID()}`
  await placed(user, MINE, 'Codex')
  await placed('someone-else', THEIRS, 'Their agent')
  const { fetch, asked } = fakeFetch({
    [`/v1/trader/${WALLET}/trades-history`]: {
      data: [
        trade(MINE, 109.60000000000001),
        trade(THEIRS, 109.5),
        trade(null, 109.4),
      ],
      nextCursor: 'next-page',
      hasMore: true,
    },
  })
  const page = await phoenixFills(db, user, WALLET, 'this-page', { fetch })
  expect(page.nextCursor).toBe('next-page')
  expect(page.fills.map((fill) => fill.placedBy)).toEqual(['Codex', null, null])
  expect(page.fills[0]).toEqual({
    time: Date.parse('2026-10-11T09:20:26Z'),
    symbol: 'SOL',
    side: 'buy',
    size: '0.1',
    price: '109.6',
    feeUsdc: '0.0038',
    realizedPnlUsdc: '0',
    signature: MINE,
    placedBy: 'Codex',
  })
  expect(asked[0]?.searchParams.get('cursor')).toBe('this-page')
  expect(asked[0]?.searchParams.get('limit')).toBe('50')
})

test('a chart range is one timeframe of Phoenix candles, in Unix seconds', async () => {
  const { fetch, asked } = fakeFetch({
    '/v1/candles/SOL': [
      {
        time: 1791612900000,
        open: 109.96,
        high: 110.09,
        low: 109.88,
        close: 109.89,
        volume: 491.48,
        volumeQuote: 54047.69,
        tradeCount: 68,
      },
    ],
  })
  expect(await phoenixCandles('SOL', '1W', { fetch })).toEqual({
    symbol: 'SOL',
    range: '1W',
    candles: [
      {
        time: 1791612900,
        open: 109.96,
        high: 110.09,
        low: 109.88,
        close: 109.89,
      },
    ],
  })
  expect(asked[0]?.searchParams.get('timeframe')).toBe('1h')
  expect(asked[0]?.searchParams.get('limit')).toBe('168')
})
