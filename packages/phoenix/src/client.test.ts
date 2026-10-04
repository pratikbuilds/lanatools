import { expect, test } from 'bun:test'
import { z } from 'zod'
import { createPhoenixClient } from './client'

test('Phoenix reads work with the Workers redirect modes', async () => {
  const client = createPhoenixClient({
    fetch: async (_url, init) => {
      // Match workerd: redirect:error throws before any network request.
      if (init?.redirect !== 'follow' && init?.redirect !== 'manual')
        throw new TypeError('Invalid redirect value')
      return Response.json({ price: 121 })
    },
  })
  expect(await client.get('/price', z.object({ price: z.number() }))).toEqual({
    price: 121,
  })
})

test('Phoenix rejects redirects without fetching their destination', async () => {
  const requests: string[] = []
  const client = createPhoenixClient({
    fetch: async (url, init) => {
      requests.push(url)
      expect(init?.redirect).toBe('manual')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/other' },
      })
    },
  })
  await expect(client.get('/price', z.unknown())).rejects.toMatchObject({
    code: 'upstream_error',
    message: 'Phoenix answered HTTP 302',
    retryable: false,
  })
  expect(requests).toEqual(['https://perp-api.phoenix.trade/price'])
})
