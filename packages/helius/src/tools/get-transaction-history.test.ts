import { expect, test } from 'bun:test'
import { runHeliusTool } from '../index'
import {
  owner,
  parsedEvent,
  rawTransaction,
  testSignature,
} from '../fixtures/parsed-events-synthetic'

const devnet = 'https://devnet.helius-rpc.com/?api-key=SYNTHETIC_SECRET'
const mainnet = 'https://mainnet.helius-rpc.com/?api-key=SYNTHETIC_SECRET'
const TOOL = 'get_transaction_history'
function mock(
  handler: (url: string, body: Record<string, unknown>) => unknown,
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) =>
    new Response(
      JSON.stringify(handler(String(url), JSON.parse(String(init?.body)))),
    )) as typeof fetch
}

test('rejects invalid inputs before calling upstream, including impossible calendar dates', async () => {
  let calls = 0
  const options = {
    rpcUrl: devnet,
    fetch: mock(() => {
      calls++
      return {}
    }),
  }
  for (const input of [
    {},
    { address: 'bad' },
    { address: owner, since: 'yesterday' },
    { address: owner, since: '2026-02-30T00:00:00Z' },
    { address: owner, since: '2026-10-03' },
    { address: owner, since: '2026-10-03T00:00:00' },
    {
      address: owner,
      since: '2026-10-04T00:00:00Z',
      until: '2026-10-03T00:00:00Z',
    },
    { address: owner, limit: 0 },
    { address: owner, limit: 101 },
    { address: owner, limit: 1.5 },
    { address: owner, status: 'OK' },
    { address: owner, cursor: 'forged' },
    { address: owner, network: 'mainnet' },
    { address: owner, filter: {} },
  ])
    expect(await runHeliusTool(TOOL, input, options)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
      credits: 0,
    })
  expect(calls).toBe(0)
})

test('devnet uses full jsonParsed data, inclusive time filters, exact deltas and default limit', async () => {
  const out = await runHeliusTool(
    TOOL,
    {
      address: owner,
      since: '2023-11-14T22:13:20.001Z',
      until: '2023-11-14T22:15:00.999Z',
      status: 'failed',
    },
    {
      rpcUrl: devnet,
      fetch: mock((url, body) => {
        expect(url).toBe(devnet)
        expect(body.method).toBe('getTransactionsForAddress')
        expect(body.params).toEqual([
          owner,
          {
            transactionDetails: 'full',
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            sortOrder: 'desc',
            limit: 10,
            filters: {
              status: 'failed',
              blockTime: { gte: 1700000001, lte: 1700000100 },
            },
          },
        ])
        return {
          result: { data: [rawTransaction(0, true)], paginationToken: null },
        }
      }),
    },
  )
  expect(out).toMatchObject({
    ok: true,
    credits: 10,
    result: {
      next_cursor: null,
      transactions: [
        {
          signature: testSignature(),
          status: 'failed',
          time: '2023-11-14T22:15:00.000Z',
          fee_sol: '0.000005',
          type: null,
          description: null,
          net_balance_changes: {
            sol: [
              { address: owner, change_sol: '-1.00204428' },
              { change_sol: '1' },
              { change_sol: '0.00203928' },
            ],
            tokens: [{ change_raw: '-1000000' }],
          },
        },
      ],
    },
  })
})

test('devnet preserves native cursor boundaries across >10 items without duplicates or gaps', async () => {
  const all = Array.from({ length: 25 }, (_, i) => rawTransaction(i))
  const seen: string[] = []
  let cursor: string | undefined
  const tokens: unknown[] = []
  const fetcher = mock((_url, body) => {
    const config = (body.params as unknown[])[1] as Record<string, unknown>
    expect(config.filters).toEqual({ status: 'any' })
    tokens.push(config.paginationToken)
    const start =
      config.paginationToken === undefined
        ? 0
        : Number(String(config.paginationToken).split(':')[1])
    const end = start + Number(config.limit)
    return {
      result: {
        data: all.slice(start, end),
        paginationToken: end < all.length ? `999:${end}` : null,
      },
    }
  })
  do {
    // runHeliusTool creates a fresh client for every page, like a worker restart.
    const out = await runHeliusTool(
      TOOL,
      { address: owner, ...(cursor ? { cursor } : {}) },
      { rpcUrl: devnet, fetch: fetcher },
    )
    if (!out.ok) throw new Error(out.error.code)
    seen.push(
      ...(out.result.transactions as { signature: string }[]).map(
        (item) => item.signature,
      ),
    )
    cursor = out.result.next_cursor as string | undefined
  } while (cursor)
  expect(tokens).toEqual([undefined, '999:10', '999:20'])
  expect(seen).toEqual(all.map((item) => item.transaction.signatures[0]!))
  expect(new Set(seen).size).toBe(25)
})

test('cursors bind all inputs and URL and are rejected before requesting another page', async () => {
  let calls = 0
  const options = {
    rpcUrl: devnet,
    fetch: mock(() => {
      calls++
      return { result: { data: [], paginationToken: '42:0' } }
    }),
  }
  const first = await runHeliusTool(TOOL, { address: owner }, options)
  if (!first.ok) throw new Error(first.error.code)
  const cursor = first.result.next_cursor
  for (const changed of [
    { limit: 11 },
    { status: 'failed' },
    { since: '2026-01-01T00:00:00Z' },
    { until: '2026-01-01T00:00:00Z' },
    { address: 'So11111111111111111111111111111111111111112' },
  ])
    expect(
      await runHeliusTool(
        TOOL,
        { address: owner, cursor, ...changed },
        options,
      ),
    ).toMatchObject({ error: { code: 'invalid_input' }, credits: 0 })
  expect(
    await runHeliusTool(
      TOOL,
      { address: owner, cursor },
      { ...options, rpcUrl: mainnet },
    ),
  ).toMatchObject({ error: { code: 'invalid_input' } })
  expect(calls).toBe(1)
})

test('mainnet filters status locally and preserves cursor through an empty filtered page', async () => {
  let calls = 0
  const fetcher = mock((url, body) => {
    calls++
    expect(url).toBe(
      'https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=SYNTHETIC_SECRET',
    )
    expect(body).toEqual({
      address: owner,
      limit: 10,
      sortOrder: 'desc',
      commitment: 'confirmed',
      includeRawTransaction: true,
      time: { gte: 1700000000, lte: 1700000200 },
      ...(calls > 1 ? { paginationToken: '49:7' } : {}),
    })
    return calls === 1
      ? { data: [parsedEvent(0)], paginationToken: '49:7' }
      : { data: [parsedEvent(1, true)] }
  })
  const input = {
    address: owner,
    status: 'failed',
    since: '2023-11-14T22:13:20Z',
    until: '2023-11-14T22:16:40Z',
  }
  const first = await runHeliusTool(TOOL, input, {
    rpcUrl: mainnet,
    fetch: fetcher,
  })
  expect(first).toMatchObject({ ok: true, result: { transactions: [] } })
  if (!first.ok) throw new Error(first.error.code)
  expect(first.result.next_cursor).toBeString()
  const next = await runHeliusTool(
    TOOL,
    { ...input, cursor: first.result.next_cursor },
    { rpcUrl: mainnet, fetch: fetcher },
  )
  expect(next).toMatchObject({
    ok: true,
    credits: 10,
    result: {
      next_cursor: null,
      transactions: [
        { signature: testSignature(1), status: 'failed', type: 'swap' },
      ],
    },
  })
  expect(calls).toBe(2)
})

test('malformed envelopes and pagination tokens fail closed', async () => {
  for (const result of [
    { transactions: [] },
    { data: null },
    { data: [], paginationToken: 123 },
    { data: [], paginationToken: '' },
    { data: [{}] },
  ]) {
    expect(
      await runHeliusTool(
        TOOL,
        { address: owner },
        { rpcUrl: devnet, fetch: mock(() => ({ result })) },
      ),
    ).toMatchObject({ error: { code: 'upstream_error' } })
  }
})

test('repeated upstream continuation token fails rather than looping forever', async () => {
  const fetcher = mock(() => ({
    result: { data: [], paginationToken: 'unchanged:1' },
  }))
  const first = await runHeliusTool(
    TOOL,
    { address: owner },
    { rpcUrl: devnet, fetch: fetcher },
  )
  if (!first.ok) throw new Error(first.error.code)
  const second = await runHeliusTool(
    TOOL,
    { address: owner, cursor: first.result.next_cursor },
    { rpcUrl: devnet, fetch: fetcher },
  )
  expect(second).toMatchObject({ error: { code: 'upstream_error' } })
})

test('sub-second empty intervals are exact and timezone offsets map correctly', async () => {
  let calls = 0
  const fetcher = mock((_url, body) => {
    calls++
    expect((body.params as unknown[])[1]).toMatchObject({
      filters: { blockTime: { gte: 1700000000, lte: 1700000100 } },
    })
    return { result: { data: [], paginationToken: null } }
  })
  const empty = await runHeliusTool(
    TOOL,
    {
      address: owner,
      since: '2023-11-14T22:13:20.001Z',
      until: '2023-11-14T22:13:20.999Z',
    },
    { rpcUrl: devnet, fetch: fetcher },
  )
  expect(empty).toMatchObject({
    ok: true,
    credits: 0,
    result: { transactions: [], next_cursor: null },
  })
  expect(calls).toBe(0)
  const shifted = await runHeliusTool(
    TOOL,
    {
      address: owner,
      since: '2023-11-14T23:13:20+01:00',
      until: '2023-11-14T23:15:00+01:00',
    },
    { rpcUrl: devnet, fetch: fetcher },
  )
  expect(shifted).toMatchObject({ ok: true })
  expect(calls).toBe(1)
})

test('sub-millisecond intervals remain exact and reversed fractions are invalid', async () => {
  let calls = 0
  const options = {
    rpcUrl: devnet,
    fetch: mock(() => {
      calls++
      return { result: { data: [], paginationToken: null } }
    }),
  }
  for (const range of [
    {
      since: '2023-11-14T22:13:20.000001Z',
      until: '2023-11-14T22:13:20.000002Z',
    },
    {
      since: '2023-11-14T23:13:20.000000000000000001+01:00',
      until: '2023-11-14T22:13:20.999999999999999999Z',
    },
  ])
    expect(
      await runHeliusTool(TOOL, { address: owner, ...range }, options),
    ).toMatchObject({
      ok: true,
      credits: 0,
      result: { transactions: [], next_cursor: null },
    })
  for (const range of [
    {
      since: '2023-11-14T22:13:20.000002Z',
      until: '2023-11-14T22:13:20.000001Z',
    },
    {
      since: '2023-11-14T23:13:20.000000000000000002+01:00',
      until: '2023-11-14T22:13:20.000000000000000001Z',
    },
  ])
    expect(
      await runHeliusTool(TOOL, { address: owner, ...range }, options),
    ).toMatchObject({
      ok: false,
      credits: 0,
      error: { code: 'invalid_input' },
    })
  expect(calls).toBe(0)
})

test('arbitrary fractional precision rounds inward without excluding exact seconds', async () => {
  const bounds: unknown[] = []
  const options = {
    rpcUrl: devnet,
    fetch: mock((_url, body) => {
      bounds.push(
        ((body.params as unknown[])[1] as Record<string, unknown>).filters,
      )
      return { result: { data: [], paginationToken: null } }
    }),
  }
  for (const range of [
    {
      since: '2023-11-14T22:13:20.000000000000000001Z',
      until: '2023-11-14T22:13:21.999999999999999999Z',
    },
    {
      since: '2023-11-14T23:13:20.000000000000000000+01:00',
      until: '2023-11-14T22:13:20Z',
    },
  ])
    expect(
      await runHeliusTool(TOOL, { address: owner, ...range }, options),
    ).toMatchObject({ ok: true })
  expect(bounds).toEqual([
    { status: 'any', blockTime: { gte: 1700000001, lte: 1700000001 } },
    { status: 'any', blockTime: { gte: 1700000000, lte: 1700000000 } },
  ])
})
