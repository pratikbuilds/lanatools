import { expect, mock, test } from 'bun:test'
import { Hono } from 'hono'
import { publicPhoenixRoutes } from './phoenix-public'
import type { PublicPhoenixEnv } from './phoenix-public'

const WALLET = '9qSuwtfRWRhYK6JrfDFkHLP1iyfCxqG3PAswQUnq917u'

function client(success: boolean) {
  const limit = mock(async () => ({ success }))
  const app = new Hono<{ Bindings: PublicPhoenixEnv }>().route(
    '/',
    publicPhoenixRoutes({
      fetch: async () =>
        Response.json({ authority: WALLET, snapshot: { subaccounts: [] } }),
    }),
  )
  const request = (path: string) =>
    app.request(
      path,
      { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
      {
        PHOENIX_PUBLIC_LIMITER: { limit },
      },
    )
  return { request, limit }
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
