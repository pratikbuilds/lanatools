import { afterAll, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { publicPhoenixRoutes } from './phoenix-public'
import type { PublicPhoenixEnv } from './phoenix-public'

const WALLET = '9qSuwtfRWRhYK6JrfDFkHLP1iyfCxqG3PAswQUnq917u'

// Bun has no Cache API, so each client gets a small one of its own.
function fakeCaches() {
  const kept = new Map<string, Response>()
  const open = async () => ({
    match: async (key: string) => kept.get(key)?.clone(),
    put: async (key: string, response: Response) => {
      kept.set(key, response)
    },
  })
  Object.defineProperty(globalThis, 'caches', {
    value: { open },
    configurable: true,
  })
}

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'caches')
})

const answer = () =>
  Response.json({ authority: WALLET, snapshot: { subaccounts: [] } })

function client(success: boolean, phoenix = answer) {
  fakeCaches()
  const limit = mock(async () => ({ success }))
  const upstream = mock(async () => phoenix())
  const app = new Hono<{ Bindings: PublicPhoenixEnv }>().route(
    '/',
    publicPhoenixRoutes({ fetch: upstream }),
  )
  const request = (path: string) =>
    app.request(
      path,
      { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
      {
        PHOENIX_PUBLIC_LIMITER: { limit },
      },
      { waitUntil: () => {}, passThroughOnException: () => {}, props: {} },
    )
  return { request, limit, upstream }
}

test('a wallet account reads with no login, limited per visitor', async () => {
  const { request, limit } = client(true)
  const response = await request(`/account/${WALLET}`)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ wallet: WALLET, exists: false })
  expect(limit).toHaveBeenCalledWith({
    key: 'lanatools:phoenix-public:203.0.113.7',
  })
})

test('past the limit a visitor is told when to retry', async () => {
  const response = await client(false).request(`/account/${WALLET}`)
  expect(response.status).toBe(429)
  expect(response.headers.get('Retry-After')).toBe('60')
})

test('a bad address is refused before Phoenix is called', async () => {
  const response = await client(true).request('/account/nope')
  expect(response.status).toBe(400)
})

test('viewers of a wallet share a Phoenix read but each counts against the limit', async () => {
  const { request, limit, upstream } = client(true)
  const first = await request(`/account/${WALLET}`)
  const second = await request(`/account/${WALLET}?fresh=1`)
  expect(second.status).toBe(200)
  expect(await second.json()).toEqual(await first.json())
  expect(first.headers.get('Cache-Control')).toBe('public, s-maxage=10')
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(limit).toHaveBeenCalledTimes(2)
})

test('a refused read is shared too, so viewers do not pile onto Phoenix', async () => {
  const { request, upstream } = client(
    true,
    () => new Response(null, { status: 429 }),
  )
  expect((await request(`/account/${WALLET}`)).status).toBe(502)
  expect((await request(`/account/${WALLET}`)).status).toBe(502)
  expect(upstream).toHaveBeenCalledTimes(1)
})
