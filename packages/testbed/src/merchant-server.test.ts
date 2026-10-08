import { expect, test } from 'bun:test'
import {
  createGatewaySpec,
  handleMerchant,
  handlePublic,
  pricedUnits,
  scenarios,
} from './merchant-server'

function request(path: string, value?: unknown) {
  return handleMerchant(
    new Request(
      `http://fixture${path}`,
      value === undefined
        ? {}
        : {
            method: 'POST',
            body: JSON.stringify(value),
          },
    ),
  )
}

test('catalog preserves legacy prices and exposes protocol and price cases', async () => {
  const catalog = await (await request('/api/v1/scenarios')).json()
  expect(catalog.scenarios).toHaveLength(20)
  expect(
    scenarios.find((route) => route.path === '/api/v1/fixed')?.price_usdc,
  ).toBe(0.01)
  expect(
    scenarios.find((route) => route.path === '/api/v1/policy-denied')
      ?.protocols,
  ).toEqual(['mpp-charge'])
  expect(
    scenarios.find((route) => route.path === '/api/v1/price/minimum')
      ?.price_usdc,
  ).toBe(0.01)
  expect(
    scenarios
      .filter((route) => route.protocols.length > 0)
      .every((route) => route.price_usdc >= 0.01),
  ).toBe(true)
  expect(
    scenarios.find((route) => route.path === '/api/v1/x402-only')?.protocols,
  ).toEqual(['x402-exact'])
})

test('every quantity gets its own exact gateway amount and public path stays private', () => {
  const spec = createGatewaySpec()
  const priced = spec.endpoints.filter((endpoint) =>
    endpoint.path.startsWith('__priced/units/'),
  )
  expect(priced).toHaveLength(200)
  expect(
    spec.endpoints.some((endpoint) => endpoint.path === 'api/v1/priced'),
  ).toBe(false)
  for (const units of [1, 2, 57, 100, 200]) {
    expect(
      priced.find((endpoint) => endpoint.path === `__priced/units/${units}`)
        ?.metering?.dimensions[0]?.tiers[0]?.price_usd,
    ).toBe(units / 100)
  }
})

test('quantity inputs are bounded and reject duplicates before reaching a gateway', async () => {
  expect(pricedUnits(new URL('http://fixture/api/v1/priced'))).toBe(1)
  for (const units of ['0', '-1', '1.5', '201', 'NaN', 'Infinity', '']) {
    const response = await handlePublic(
      new Request(`http://fixture/api/v1/priced?units=${units}`),
      'http://127.0.0.1:1',
    )
    expect(response.status).toBe(400)
  }
  expect(
    (
      await handlePublic(
        new Request('http://fixture/api/v1/priced?units=1&units=100'),
      )
    ).status,
  ).toBe(400)
  expect(
    (
      await handlePublic(
        new Request('http://fixture/api/v1/priced', { method: 'POST' }),
      )
    ).status,
  ).toBe(405)
  for (const path of ['/__priced/units/1', '/%5f%5fpriced/units/100']) {
    expect(
      (await handlePublic(new Request(`http://fixture${path}`))).status,
    ).toBe(404)
  }
})

test('quantity-priced output follows the input price and private route charge', async () => {
  for (const [units, price] of [
    [1, '0.01'],
    [100, '1.00'],
    [200, '2.00'],
  ] as const) {
    const response = await (
      await request(`/api/v1/priced?units=${units}`)
    ).json()
    expect(response.units).toBe(units)
    expect(response.price_usdc).toBe(price)
    expect(response.amount_base_units).toBe(String(units * 10_000))
    expect(response.rows).toHaveLength(units)
  }
  const internal = await (await request('/__priced/units/100?units=1')).json()
  expect(internal.price_usdc).toBe('1.00')
  const preview = await (
    await request('/api/v1/preview', {
      path: '/api/v1/priced',
      query: { units: '200' },
    })
  ).json()
  expect(preview.body.price_usdc).toBe('2.00')
  expect(preview.payment_performed).toBe(false)
})

test('router selects the exact charge, preserves credentials, and stays on its gateway origin', async () => {
  const gateway = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(incoming) {
      const url = new URL(incoming.url)
      return Response.json({
        path: url.pathname,
        query: url.search,
        authorization: incoming.headers.get('authorization'),
      })
    },
  })
  try {
    const selected = await handlePublic(
      new Request('http://merchant/api/v1/priced?units=100&seed=test', {
        headers: { authorization: 'Payment fixture-credential' },
      }),
      gateway.url.origin,
    )
    expect(await selected.json()).toEqual({
      path: '/__priced/units/100',
      query: '?units=100&seed=test',
      authorization: 'Payment fixture-credential',
    })
    for (const path of [
      '//example.invalid/api',
      '//__priced/units/1',
      '/%2f__priced/units/1',
    ]) {
      const unusual = await handlePublic(
        new Request(`http://merchant${path}`),
        gateway.url.origin,
      )
      expect(unusual.status).toBe(404)
    }
  } finally {
    await gateway.stop(true)
  }
})

test('echo preserves repeated query keys and nested JSON without credential headers', async () => {
  const input = { items: [1, { nested: true }] }
  const response = await handleMerchant(
    new Request('http://fixture/api/v1/echo?tag=a&tag=b', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { authorization: 'secret', 'payment-signature': 'secret' },
    }),
  )
  expect(await response.json()).toEqual({
    method: 'POST',
    query: { tag: ['a', 'b'] },
    body: input,
  })
  expect(response.headers.get('x-request-id')).toBeTruthy()
  expect(response.headers.get('cache-control')).toBe('no-store')
})

test('quote fixtures repeat by seed and change with input', async () => {
  const first = await (
    await request('/api/v1/quote?symbol=SOL&seed=one')
  ).json()
  expect(
    await (await request('/api/v1/quote?symbol=SOL&seed=one')).json(),
  ).toEqual(first)
  expect(
    await (await request('/api/v1/quote?symbol=SOL&seed=two')).json(),
  ).not.toEqual(first)
  expect(first.simulated).toBe(true)
})

test('summary counts text and accepts Unicode', async () => {
  expect(
    await (
      await request('/api/v1/summarize', { text: 'Hello world. नमस्ते!' })
    ).json(),
  ).toMatchObject({ words: 3, sentences: 2, simulated: true })
})

test('JSON and CSV datasets contain matching deterministic rows', async () => {
  const json = await (await request('/api/v1/dataset?count=2&seed=one')).json()
  const csv = await request('/api/v1/dataset?count=2&seed=one&format=csv')
  expect(csv.headers.get('content-type')).toContain('text/csv')
  expect(await csv.text()).toBe(
    `id,label,value\n1,item-1,${json.rows[0].value}\n2,item-2,${json.rows[1].value}\n`,
  )
})

test('text and large responses preserve their exact output size', async () => {
  expect(await (await request('/api/v1/text?message=hello')).text()).toBe(
    'hello',
  )
  expect(
    (await (await request('/api/v1/large?bytes=1048576')).arrayBuffer())
      .byteLength,
  ).toBe(1048576)
})

test('delay waits before responding', async () => {
  const start = performance.now()
  expect(await (await request('/api/v1/delay?ms=25')).json()).toEqual({
    status: 'ok',
    delayed_ms: 25,
  })
  expect(performance.now() - start).toBeGreaterThanOrEqual(20)
})

test('error fixtures preserve status and retry headers', async () => {
  for (const code of [400, 404, 422, 429, 500, 503]) {
    const response = await request(`/api/v1/status?code=${code}`)
    expect(response.status).toBe(code)
    expect((await response.json()).error).toBe('simulated_error')
    expect(response.headers.get('retry-after')).toBe(
      code === 429 || code === 503 ? '1' : null,
    )
  }
})

test('out-of-range, malformed, and unsupported inputs fail explicitly', async () => {
  for (const path of [
    '/api/v1/delay?ms=30001',
    '/api/v1/large?bytes=0',
    '/api/v1/dataset?count=1.5',
    '/api/v1/quote?symbol=UNKNOWN',
    '/api/v1/status?code=302',
    '/api/v1/dataset?format=html',
  ]) {
    expect((await request(path)).status).toBe(400)
  }
  expect((await request('/api/v1/summarize', { text: 42 })).status).toBe(400)
  expect(
    (
      await handleMerchant(
        new Request('http://fixture/api/v1/echo', {
          method: 'POST',
          body: '{',
        }),
      )
    ).status,
  ).toBe(400)
  expect(
    (await request('/api/v1/echo', { text: 'x'.repeat(65536) })).status,
  ).toBe(400)
})

test('unknown paths and unsupported methods never return success', async () => {
  expect((await request('/unknown')).status).toBe(404)
  expect((await request('/api/v1/quote', {})).status).toBe(404)
})

test('free preview reproduces output and errors without claiming payment', async () => {
  const output = await (
    await request('/api/v1/preview', {
      path: '/api/v1/echo',
      method: 'POST',
      body: { message: 'hello' },
      query: { tag: ['a', 'b'] },
    })
  ).json()
  expect(output).toMatchObject({
    preview: true,
    payment_performed: false,
    status: 200,
    body: {
      method: 'POST',
      body: { message: 'hello' },
      query: { tag: ['a', 'b'] },
    },
  })
  const error = await (
    await request('/api/v1/preview', {
      path: '/api/v1/status',
      query: { code: '429' },
    })
  ).json()
  expect(error.status).toBe(429)
  expect(error.payment_performed).toBe(false)
  expect(
    (await request('/api/v1/preview', { path: 'https://example.com' })).status,
  ).toBe(400)
  expect(
    (await request('/api/v1/preview', { path: '/api/v1/preview' })).status,
  ).toBe(400)
})
