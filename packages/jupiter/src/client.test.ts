import { expect, test } from 'bun:test'
import { getAddressDecoder } from '@solana/kit'
import { JupiterClient } from './index'
import type { JupiterClientOptions } from './index'

const SOL = 'So11111111111111111111111111111111111111112'
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function fixture(
  responses: (unknown | Response | Error)[],
  options: Partial<JupiterClientOptions> = {},
) {
  const calls: { url: URL; init: RequestInit | undefined }[] = []
  const client = new JupiterClient({
    apiKey: 'server-test-key',
    fetch: (url, init) => {
      calls.push({ url: new URL(url), init })
      const response = responses.shift()
      if (response instanceof Error) return Promise.reject(response)
      return Promise.resolve(
        response instanceof Response ? response : Response.json(response),
      )
    },
    ...options,
  })
  return { client, calls }
}

test('exact search deduplicates, preserves optional metadata and reports missing mints', async () => {
  const token = {
    id: SOL,
    icon: null,
    usdPrice: 0.123456789012345,
    newProviderField: { value: true },
  }
  const { client, calls } = fixture([[token]])
  const result = await client.read({
    tool: 'jupiter_search_tokens',
    input: { mints: [` ${SOL} `, SOL, JUP] },
  })
  expect(result.ok).toBe(true)
  if (!result.ok || !('tokens' in result.result.data))
    throw new Error('Missing search result')
  expect(result.result.data).toEqual({
    tokens: [token],
    missingMints: [JUP],
    verificationEligibility: null,
    eligibilityError: null,
  })
  expect(result.result.network).toBe('mainnet-beta')
  expect(result.result.fetchedAt).toEqual(expect.any(String))
  expect(calls[0]?.url.searchParams.get('query')).toBe(`${SOL},${JUP}`)
  expect(calls[0]?.init?.headers).toEqual({
    'x-api-key': 'server-test-key',
    Accept: 'application/json',
  })
  expect(calls[0]?.init?.method).toBe('GET')
  expect(calls[0]?.init?.redirect).toBe('error')
})

test('name lookup has no arbitrary character cap and preserves candidate order', async () => {
  const tokens = [{ id: JUP }, { id: SOL }]
  const { client, calls } = fixture([tokens])
  const query = 'x'.repeat(200)
  const result = await client.read({
    tool: 'jupiter_search_tokens',
    input: { query: ` ${query} ` },
  })
  expect(result.ok).toBe(true)
  if (!result.ok || !('tokens' in result.result.data))
    throw new Error('Missing search result')
  expect(result.result.data.tokens).toEqual(tokens)
  expect(result.result.warnings.join(' ')).toContain('not be exhaustive')
  expect(calls[0]?.url.searchParams.get('query')).toBe(query)
})

test('eligibility is still checked after an empty successful metadata lookup', async () => {
  const eligibility = {
    tokenExists: true,
    isVerified: false,
    canVerify: true,
    canMetadata: false,
    metadataError: 'Pending request',
  }
  const { client, calls } = fixture([[], eligibility])
  const result = await client.read({
    tool: 'jupiter_search_tokens',
    input: { mints: [JUP, JUP], includeVerificationEligibility: true },
  })
  expect(result.ok).toBe(true)
  if (!result.ok || !('eligibilityError' in result.result.data))
    throw new Error('Missing search result')
  expect(result.result.data.verificationEligibility).toEqual(eligibility)
  expect(result.result.data.missingMints).toEqual([JUP])
  expect(calls[1]?.url.pathname).toBe(
    '/tokens/v2/verify/express/check-eligibility',
  )
  expect(calls[1]?.url.searchParams.get('tokenId')).toBe(JUP)
})

test('failed enrichment retries only eligibility and retains successful metadata', async () => {
  const { client, calls } = fixture([
    [{ id: JUP }],
    new Response('secret provider body', { status: 503 }),
    new Response('secret provider body', { status: 503 }),
  ])
  const result = await client.read({
    tool: 'jupiter_search_tokens',
    input: { mints: [JUP], includeVerificationEligibility: true },
  })
  expect(result.ok).toBe(true)
  if (!result.ok || !('eligibilityError' in result.result.data))
    throw new Error('Missing search result')
  expect(result.result.data.tokens).toEqual([{ id: JUP }])
  expect(result.result.data.eligibilityError?.code).toBe('upstream_unavailable')
  expect(calls.map((call) => call.url.pathname)).toEqual([
    '/tokens/v2/search',
    '/tokens/v2/verify/express/check-eligibility',
    '/tokens/v2/verify/express/check-eligibility',
  ])
  expect(JSON.stringify(result)).not.toContain('secret provider body')
})

test('unusual optional metadata produces warnings rather than losing usable records', async () => {
  const records = [{ id: JUP }, { id: JUP }, { newField: 1 }]
  const { client } = fixture([records])
  const result = await client.read({
    tool: 'jupiter_search_tokens',
    input: { mints: [JUP] },
  })
  expect(result.ok).toBe(true)
  if (!result.ok || !('tokens' in result.result.data))
    throw new Error('Missing search result')
  expect(result.result.data.tokens).toEqual(records)
  expect(result.result.warnings.length).toBeGreaterThan(0)
})

test('invalid input and missing server configuration never reach the provider', async () => {
  const { client, calls } = fixture([])
  for (const input of [
    { query: ' ' },
    { query: 'JUP', mints: [JUP] },
    { query: 'JUP', includeVerificationEligibility: true },
  ]) {
    expect(
      await client.read({ tool: 'jupiter_search_tokens', input }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  const unconfigured = fixture([], { apiKey: '' })
  expect(
    await unconfigured.client.read({
      tool: 'jupiter_get_prices',
      input: { mints: [SOL] },
    }),
  ).toMatchObject({ ok: false, error: { retryable: false } })
  expect(calls).toHaveLength(0)
  expect(unconfigured.calls).toHaveLength(0)
})

test('all discovery views map to documented endpoints and report local pagination', async () => {
  const tokens = [{ id: SOL }, { id: JUP }, { id: USDC }]
  const { client, calls } = fixture([tokens, tokens, tokens])
  const ranked = await client.read({
    tool: 'jupiter_discover_tokens',
    input: {
      view: 'ranked',
      category: 'toptrending',
      interval: '24h',
      limit: 2,
    },
  })
  const tagged = await client.read({
    tool: 'jupiter_discover_tokens',
    input: { view: 'tag', tag: 'verified', limit: 1, offset: 1 },
  })
  const recent = await client.read({
    tool: 'jupiter_discover_tokens',
    input: { view: 'recent', limit: 2, offset: 2 },
  })
  expect(calls.map((call) => call.url.pathname)).toEqual([
    '/tokens/v2/toptrending/24h',
    '/tokens/v2/tag',
    '/tokens/v2/recent',
  ])
  expect(calls.map((call) => call.url.search)).toEqual([
    '?limit=2',
    '?query=verified',
    '',
  ])
  expect(ranked).toMatchObject({
    ok: true,
    result: {
      data: {
        tokens,
        pagination: { nextOffset: null, upstreamPagination: false },
      },
    },
  })
  expect(tagged).toMatchObject({
    ok: true,
    result: {
      data: {
        tokens: [{ id: JUP }],
        pagination: { returned: 1, nextOffset: 2, upstreamPagination: false },
      },
    },
  })
  expect(recent).toMatchObject({
    ok: true,
    result: {
      data: {
        tokens: [{ id: USDC }],
        pagination: { returned: 1, nextOffset: null },
      },
    },
  })
})

test('prices preserve precision and nulls while omitted mints stay missing', async () => {
  const price = {
    usdPrice: 0.000000123456789,
    liquidity: 123.45,
    createdAt: '2026-01-01T00:00:00Z',
    decimals: 9,
    blockId: null,
    priceChange24h: null,
    extra: true,
  }
  const { client, calls } = fixture([{ [SOL]: price }])
  const result = await client.read({
    tool: 'jupiter_get_prices',
    input: { mints: [SOL, SOL, JUP] },
  })
  expect(result).toMatchObject({
    ok: true,
    result: { data: { prices: { [SOL]: price }, missingMints: [JUP] } },
  })
  expect(calls[0]?.url.pathname).toBe('/price/v3')
  expect(calls[0]?.url.searchParams.get('ids')).toBe(`${SOL},${JUP}`)
})

test('empty and malformed top-level responses have distinct outcomes', async () => {
  const { client } = fixture([{}, [], null, new Response('not json')])
  expect(
    await client.read({ tool: 'jupiter_get_prices', input: { mints: [SOL] } }),
  ).toMatchObject({
    ok: true,
    result: { data: { prices: {}, missingMints: [SOL] } },
  })
  expect(
    await client.read({
      tool: 'jupiter_search_tokens',
      input: { query: 'JUP' },
    }),
  ).toMatchObject({ ok: true, result: { data: { tokens: [] } } })
  expect(
    await client.read({
      tool: 'jupiter_search_tokens',
      input: { query: 'JUP' },
    }),
  ).toMatchObject({ ok: false, error: { retryable: false } })
  expect(
    await client.read({
      tool: 'jupiter_search_tokens',
      input: { query: 'JUP' },
    }),
  ).toMatchObject({ ok: false, error: { retryable: false } })
})

test('429 Retry-After beyond the deadline is reported without another call', async () => {
  const { client, calls } = fixture([
    new Response('do not expose', {
      status: 429,
      headers: { 'Retry-After': '120' },
    }),
  ])
  expect(
    await client.read({ tool: 'jupiter_get_prices', input: { mints: [SOL] } }),
  ).toMatchObject({
    ok: false,
    error: { code: 'rate_limited', retryable: true, retryAfterSeconds: 120 },
  })
  expect(calls).toHaveLength(1)
})

test('key rejection is not retried or relayed as a user credential request', async () => {
  const { client, calls } = fixture([
    new Response('server-test-key', { status: 403 }),
  ])
  const result = await client.read({
    tool: 'jupiter_search_tokens',
    input: { query: 'JUP', includeVerificationEligibility: false },
  })
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'upstream_unavailable', retryable: false },
  })
  expect(JSON.stringify(result)).not.toContain('server-test-key')
  expect(calls).toHaveLength(1)
})

test('timeout cancellation is bounded by the tool deadline', async () => {
  let calls = 0
  const client = new JupiterClient({
    apiKey: 'test',
    requestTimeoutMs: 5,
    toolTimeoutMs: 20,
    fetch: (_url, init) => {
      calls++
      return new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('secret transport detail')),
          { once: true },
        ),
      )
    },
  })
  expect(
    await client.read({
      tool: 'jupiter_search_tokens',
      input: { query: 'JUP' },
    }),
  ).toMatchObject({ ok: false, error: { retryable: true } })
  expect(calls).toBe(1)
})

test('upstream batch caps apply after normalization', async () => {
  const { client, calls } = fixture([{}])
  expect(
    (
      await client.read({
        tool: 'jupiter_get_prices',
        input: { mints: Array.from({ length: 60 }, () => SOL) },
      })
    ).ok,
  ).toBe(true)
  const mints = Array.from({ length: 51 }, (_, i) => {
    const bytes = new Uint8Array(32)
    bytes[0] = i + 1
    return getAddressDecoder().decode(bytes)
  })
  const result = await client.read({
    tool: 'jupiter_get_prices',
    input: { mints },
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(calls).toHaveLength(1)
})
