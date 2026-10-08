import { join } from 'node:path'

type Endpoint = {
  method: string
  path: string
  description: string
  metering?: {
    schemes: Array<string>
    dimensions: Array<{
      direction: string
      unit: string
      scale: number
      tiers: Array<{ price_usd: number }>
    }>
  }
}

const spec = Bun.YAML.parse(
  await Bun.file(join(import.meta.dir, '..', 'merchant.yaml')).text(),
) as { operator: { network: string }; endpoints: Array<Endpoint> }

export const quantityPricing = {
  type: 'quantity',
  parameter: 'units',
  unit_price_usdc: 0.01,
  min_units: 1,
  max_units: 200,
  default_units: 1,
} as const

const PRICED_PATH = '/api/v1/priced'
const PRIVATE_PREFIX = '/__priced/units/'

/** The public router selects one of these exact charges before payment. */
export function createGatewaySpec() {
  const result = structuredClone(spec)
  const priced = result.endpoints.find(
    (endpoint) => `/${endpoint.path}` === PRICED_PATH,
  )
  if (!priced?.metering) throw new Error('Quantity-priced endpoint is missing')
  result.endpoints = result.endpoints.filter((endpoint) => endpoint !== priced)
  for (let units = 1; units <= quantityPricing.max_units; units++) {
    result.endpoints.push({
      ...priced,
      path: `${PRIVATE_PREFIX.slice(1)}${units}`,
      metering: {
        schemes: priced.metering.schemes,
        dimensions: [
          {
            tiers: [{ price_usd: units / 100 }],
            direction: 'usage',
            unit: 'requests',
            scale: 1,
          },
        ],
      },
    })
  }
  return result
}

const examples: Record<string, unknown> = {
  'GET api/v1/echo': { query: { message: 'hello', tag: ['one', 'two'] } },
  'POST api/v1/echo': {
    headers: { 'content-type': 'application/json' },
    body: { message: 'hello', items: [1, 2, 3] },
  },
  'GET api/v1/quote': { query: { symbol: 'SOL', seed: 'test-1' } },
  'POST api/v1/summarize': {
    headers: { 'content-type': 'application/json' },
    body: { text: 'Solana payments. Test both protocols.' },
  },
  'GET api/v1/dataset': {
    query: { count: '5', seed: 'test-1', format: 'csv' },
  },
  'GET api/v1/text': { query: { message: 'hello world' } },
  'GET api/v1/large': { query: { bytes: '262144' } },
  'GET api/v1/delay': { query: { ms: '2000' } },
  'GET api/v1/status': { query: { code: '503' } },
  'GET api/v1/priced': { query: { units: '100', seed: 'test-1' } },
}

export const scenarios = spec.endpoints.map((endpoint) => ({
  method: endpoint.method,
  path: `/${endpoint.path}`,
  description: endpoint.description,
  price_usdc: endpoint.metering?.dimensions[0]?.tiers[0]?.price_usd ?? 0,
  ...(`/${endpoint.path}` === PRICED_PATH ? { pricing: quantityPricing } : {}),
  protocols: endpoint.metering?.schemes ?? [],
  example: examples[`${endpoint.method} ${endpoint.path}`] ?? {},
}))

class InputError extends Error {}

function integer(
  url: URL,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
    throw new InputError(`${key} must be an integer between ${min} and ${max}`)
  return Number(raw)
}

export function pricedUnits(url: URL) {
  if (url.searchParams.getAll('units').length > 1)
    throw new InputError('units must be supplied once')
  return integer(
    url,
    'units',
    quantityPricing.default_units,
    quantityPricing.min_units,
    quantityPricing.max_units,
  )
}

function choice(
  url: URL,
  key: string,
  fallback: string,
  allowed: Array<string>,
) {
  const value = url.searchParams.get(key) ?? fallback
  if (!allowed.includes(value))
    throw new InputError(`${key} must be one of: ${allowed.join(', ')}`)
  return value
}

function text(value: unknown, name: string, fallback?: string) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'string' || value.length > 16_384)
    throw new InputError(`${name} must be a string of at most 16384 characters`)
  return value
}

async function body(request: Request): Promise<unknown> {
  // Also bound chunked requests, whose Content-Length can be absent.
  if (!request.body) throw new InputError('A JSON body is required')
  const reader = request.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > 65_536) {
      await reader.cancel()
      throw new InputError('JSON body must be at most 65536 bytes')
    }
    chunks.push(chunk.value)
  }
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new InputError('Body must contain valid JSON')
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InputError('Body must be a JSON object')
  return value as Record<string, unknown>
}

function query(url: URL) {
  return Object.fromEntries(
    [...new Set(url.searchParams.keys())].map((key) => {
      const values = url.searchParams.getAll(key)
      return [key, values.length === 1 ? values[0] : values]
    }),
  )
}

function sample(seed: string, index: number) {
  // Stable fixtures let repeated MPP and x402 calls compare the same data.
  return (BigInt(Bun.hash.wyhash(`${seed}:${index}`, 0n)) % 100_000n).toString()
}

async function runScenario(request: Request, endpoint: Endpoint) {
  const url = new URL(request.url)
  switch (endpoint.path) {
    case 'api/v1/priced': {
      const units = pricedUnits(url)
      const seed = text(url.searchParams.get('seed') ?? 'default', 'seed')
      return Response.json({
        simulated: true,
        units,
        unit_price_usdc: '0.01',
        price_usdc: (units / 100).toFixed(2),
        amount_base_units: String(units * 10_000),
        rows: Array.from({ length: units }, (_, index) => ({
          id: index + 1,
          value: Number(sample(seed, index)),
        })),
      })
    }
    case 'api/v1/fixed':
    case 'api/v1/policy-denied':
      return Response.json({ status: 'ok' })
    case 'api/v1/echo':
      return Response.json({
        method: request.method,
        query: query(url),
        body: request.method === 'POST' ? await body(request) : null,
      })
    case 'api/v1/quote': {
      const symbol = choice(url, 'symbol', 'SOL', ['SOL', 'BTC', 'ETH', 'USDC'])
      const seed = text(url.searchParams.get('seed') ?? 'default', 'seed')
      const bases: Record<string, number> = {
        SOL: 150,
        BTC: 60000,
        ETH: 3000,
        USDC: 1,
      }
      const variation = Number(sample(`${seed}:${symbol}`, 0)) / 100_000
      return Response.json({
        simulated: true,
        symbol,
        seed,
        currency: 'USD',
        price: Number(
          ((bases[symbol] ?? 1) * (0.98 + variation * 0.04)).toFixed(6),
        ),
      })
    }
    case 'api/v1/summarize': {
      const input = text(object(await body(request)).text, 'text')
      const words = input.trim().split(/\s+/).filter(Boolean)
      return Response.json({
        simulated: true,
        summary: words.slice(0, 20).join(' '),
        words: words.length,
        characters: input.length,
        sentences: input.split(/[.!?]+/).filter((part) => part.trim()).length,
      })
    }
    case 'api/v1/dataset': {
      const count = integer(url, 'count', 5, 1, 1000)
      const seed = text(url.searchParams.get('seed') ?? 'default', 'seed')
      const format = choice(url, 'format', 'json', ['json', 'csv'])
      const rows = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        label: `item-${index + 1}`,
        value: Number(sample(seed, index)),
      }))
      if (format === 'csv')
        return new Response(
          [
            'id,label,value',
            ...rows.map((row) => `${row.id},${row.label},${row.value}`),
          ].join('\n') + '\n',
          { headers: { 'content-type': 'text/csv; charset=utf-8' } },
        )
      return Response.json({ simulated: true, seed, count, rows })
    }
    case 'api/v1/text':
      return new Response(
        text(
          url.searchParams.get('message') ??
            'Hello from the devnet merchant.\n',
          'message',
        ),
        {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        },
      )
    case 'api/v1/large': {
      const bytes = integer(url, 'bytes', 262144, 1, 1048576)
      return new Response('x'.repeat(bytes), {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'x-fixture-bytes': String(bytes),
        },
      })
    }
    case 'api/v1/delay': {
      const ms = integer(url, 'ms', 1000, 0, 30000)
      await Bun.sleep(ms)
      return Response.json({ status: 'ok', delayed_ms: ms })
    }
    case 'api/v1/status': {
      const code = Number(
        choice(url, 'code', '503', ['400', '404', '422', '429', '500', '503']),
      )
      return Response.json(
        {
          error: 'simulated_error',
          status: code,
          message: `Deliberate HTTP ${code} fixture`,
        },
        {
          status: code,
          headers: code === 429 || code === 503 ? { 'retry-after': '1' } : {},
        },
      )
    }
    default:
      return Response.json({
        status: 'ok',
        scenario: endpoint.path,
        price_usdc: endpoint.metering?.dimensions[0]?.tiers[0]?.price_usd,
      })
  }
}

async function preview(request: Request) {
  const input = object(await body(request))
  const path = text(input.path, 'path')
  const method = text(input.method, 'method', 'GET')
  const endpoint = spec.endpoints.find(
    (item) =>
      `/${item.path}` === path && item.method === method && item.metering,
  )
  if (!endpoint)
    throw new InputError('Choose a paid path and method from /api/v1/scenarios')
  const url = new URL(path, 'http://fixture')
  if (input.query !== undefined) {
    for (const [key, value] of Object.entries(object(input.query))) {
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, text(item, `query.${key}`))
    }
  }
  const response = await runScenario(
    new Request(url, {
      method,
      ...(method === 'POST'
        ? { body: JSON.stringify(input.body ?? null) }
        : {}),
    }),
    endpoint,
  )
  const contentType = response.headers.get('content-type') ?? ''
  const output = await response.text()
  return Response.json({
    preview: true,
    payment_performed: false,
    status: response.status,
    content_type: contentType,
    body: contentType.includes('application/json')
      ? (JSON.parse(output) as unknown)
      : output,
  })
}

export async function handleMerchant(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // Private paths are reachable only from the loopback payment gateway.
  const privateUnits = /^\/__priced\/units\/([1-9]\d{0,2})$/.exec(
    url.pathname,
  )?.[1]
  if (
    privateUnits &&
    Number(privateUnits) <= quantityPricing.max_units &&
    request.method === 'GET'
  ) {
    url.pathname = PRICED_PATH
    url.searchParams.set('units', privateUnits)
    request = new Request(url, request)
  }
  const endpoint = spec.endpoints.find(
    (item) =>
      `/${item.path}` === url.pathname && item.method === request.method,
  )
  let response: Response
  try {
    if (!endpoint)
      response = Response.json({ error: 'not_found' }, { status: 404 })
    else if (url.pathname === '/health')
      response = Response.json({
        status: 'ok',
        service: 'lanatools-testbed',
        version: 2,
      })
    else if (url.pathname === '/api/v1/scenarios')
      response = Response.json({
        simulated: true,
        scenarios,
        preview: {
          method: 'POST',
          path: '/api/v1/preview',
          body: {
            path: '/api/v1/echo',
            method: 'POST',
            body: { message: 'hello' },
          },
        },
        notes: [
          'Prices are devnet USDC per call. Quote and summary data are simulated.',
          'Exact payments settle before the upstream runs. Errors and timeouts can still be charged; do not blindly retry.',
          'policy-denied tests the payer policy; this merchant does not guarantee a refusal.',
        ],
      })
    else if (url.pathname === '/api/v1/preview')
      response = await preview(request)
    else response = await runScenario(request, endpoint)
  } catch (error) {
    if (!(error instanceof InputError)) throw error
    response = Response.json(
      { error: 'invalid_input', message: error.message },
      { status: 400 },
    )
  }
  response.headers.set('cache-control', 'no-store')
  response.headers.set('x-request-id', crypto.randomUUID())
  return response
}

export async function handlePublic(
  request: Request,
  gatewayOrigin = 'http://127.0.0.1:1404',
): Promise<Response> {
  const url = new URL(request.url)
  try {
    const decodedPath = decodeURIComponent(url.pathname)
    if (decodedPath.includes('//') || /^\/__priced(?:\/|$)/.test(decodedPath))
      return Response.json({ error: 'not_found' }, { status: 404 })
    const target = new URL(gatewayOrigin)
    target.pathname = url.pathname
    target.search = url.search
    if (url.pathname === PRICED_PATH) {
      if (request.method !== 'GET')
        return Response.json(
          { error: 'method_not_allowed' },
          { status: 405, headers: { allow: 'GET' } },
        )
      const units = pricedUnits(url)
      // Validate the other input before any charge, too.
      text(url.searchParams.get('seed') ?? 'default', 'seed')
      target.pathname = `${PRIVATE_PREFIX}${units}`
    }
    const headers = new Headers(request.headers)
    headers.set('host', url.host)
    headers.delete('connection')
    const response = await fetch(target, {
      method: request.method,
      headers,
      ...(request.method !== 'GET' && request.method !== 'HEAD'
        ? { body: await request.arrayBuffer() }
        : {}),
      redirect: 'manual',
      signal: request.signal,
    })
    if (url.pathname !== '/openapi.json' || response.status !== 200)
      return response
    const document = (await response.json()) as {
      paths: Record<string, unknown>
    }
    for (const path of Object.keys(document.paths)) {
      if (path.startsWith('/__priced/')) delete document.paths[path]
    }
    document.paths[PRICED_PATH] = {
      get: {
        summary:
          'Charge units x 0.01 USDC, between 0.01 and 2 USDC. The request-specific 402 contains the exact amount.',
        parameters: [
          {
            name: 'units',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 1 },
          },
          {
            name: 'seed',
            in: 'query',
            schema: { type: 'string', maxLength: 16384 },
          },
        ],
        'x-pricing': quantityPricing,
        responses: {
          '200': { description: 'Paid JSON dataset' },
          '400': { description: 'Invalid input; no payment attempted' },
          '402': {
            description: 'Exact price for the supplied units over MPP or x402',
          },
        },
      },
    }
    return Response.json(document, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof InputError || error instanceof URIError)
      return Response.json(
        { error: 'invalid_input', message: error.message },
        { status: 400 },
      )
    return Response.json({ error: 'gateway_unavailable' }, { status: 503 })
  }
}

export function startMerchant(
  options: { hostname?: string; port?: number } = {},
) {
  const fixture = Bun.serve({
    hostname: '127.0.0.1',
    port: 1403,
    idleTimeout: 60,
    maxRequestBodySize: 65_536,
    fetch: handleMerchant,
  })
  try {
    const frontend = Bun.serve({
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 1402,
      idleTimeout: 60,
      maxRequestBodySize: 65_536,
      fetch: (request) => handlePublic(request),
    })
    return {
      url: frontend.url,
      stop: (force: boolean) =>
        Promise.all([frontend.stop(force), fixture.stop(force)]),
    }
  } catch (error) {
    void fixture.stop(true)
    throw error
  }
}

if (import.meta.main) {
  if (Bun.argv[2] === '--write-gateway-spec') {
    const path = Bun.argv[3]
    if (!path) throw new Error('A gateway spec path is required')
    const gatewaySpec = createGatewaySpec()
    gatewaySpec.operator.network = 'devnet'
    await Bun.write(path, Bun.YAML.stringify(gatewaySpec, null, 2))
  } else {
    const server = startMerchant({
      hostname: '0.0.0.0',
      port: Number(process.env.PORT ?? 1402),
    })
    console.log(`Merchant router on ${server.url}`)
  }
}
