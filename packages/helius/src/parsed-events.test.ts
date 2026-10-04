import { expect, test } from 'bun:test'
import { runHeliusTool } from './index'
import { parsedTransactionSummary } from './parsed-events'
import {
  owner,
  parsedEvent,
  rawTransaction,
  testSignature,
} from './fixtures/parsed-events-synthetic'
import { transactionSummary } from './transactions'

const rpcUrl =
  'https://mainnet.helius-rpc.com/?api-key=SYNTHETIC_SECRET&partner=lanatools'
function response(value: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(value))) as unknown as typeof fetch
}

test('mainnet uses new Parsed Events POST and preserves duplicate signature order', async () => {
  const signatures = [
    testSignature(),
    testSignature(1),
    testSignature(),
    testSignature(2),
  ]
  let calls = 0
  const out = await runHeliusTool(
    'get_transactions',
    { signatures, detail: 'full' },
    {
      rpcUrl,
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls++
        expect(String(url)).toBe(
          'https://mainnet.helius-rpc.com/v1/parsed-events/transactions?api-key=SYNTHETIC_SECRET&partner=lanatools',
        )
        expect(init?.method).toBe('POST')
        expect(JSON.parse(String(init?.body))).toEqual({
          transactions: signatures,
          commitment: 'confirmed',
          includeRawTransaction: true,
        })
        return new Response(
          JSON.stringify([
            parsedEvent(),
            parsedEvent(1, true),
            parsedEvent(),
            {
              signature: testSignature(2),
              parserStatus: 'ERROR',
              parserError: {
                code: 'transaction_not_found',
                message: 'synthetic not found',
              },
            },
          ]),
        )
      }) as typeof fetch,
    },
  )
  expect(calls).toBe(1)
  expect(out).toMatchObject({ ok: true, credits: 10 })
  if (!out.ok) throw new Error(out.error.code)
  const tx = out.result.transactions as Record<string, unknown>[]
  expect(tx.map((item) => item.signature)).toEqual(signatures)
  expect(tx[0]).toMatchObject({
    found: true,
    status: 'succeeded',
    type: 'swap',
    description: 'Synthetic swap for offline coverage',
    fee_sol: '0.000005',
    transfers: [
      { amount: '1', unit: 'SOL' },
      { amount: '18446744073709.551615', unit: 'token' },
    ],
    instructions: [{ instructionName: 'transfer_checked' }],
    net_balance_changes: {
      sol: [
        { address: owner, change_sol: '-1.00204428' },
        { change_sol: '1' },
        { change_sol: '0.00203928' },
      ],
      tokens: [{ change_raw: '-1000000' }],
    },
  })
  expect(tx[1]).toMatchObject({
    status: 'failed',
    error: { InstructionError: [0, 'InvalidArgument'] },
  })
  expect(tx[3]).toEqual({ signature: testSignature(2), found: false })
})

test('only transaction_not_found produces found:false; parser errors are unknown and sanitized', async () => {
  const out = await runHeliusTool(
    'get_transactions',
    { signatures: [testSignature()] },
    {
      rpcUrl,
      fetch: response([
        {
          signature: testSignature(),
          parserStatus: 'ERROR',
          parserError: { code: 'parse_failed', message: `private ${rpcUrl}` },
        },
      ]),
    },
  )
  expect(out).toMatchObject({
    ok: true,
    result: {
      transactions: [
        {
          found: null,
          status: 'unknown',
          parser_error: { code: 'upstream_error' },
        },
      ],
    },
  })
  expect(JSON.stringify(out)).not.toContain('SYNTHETIC_SECRET')
  expect(JSON.stringify(out)).not.toContain('private')
})

test('mainnet summary excludes instructions and missing raw balances remain unknown', () => {
  const fixture: Record<string, unknown> = parsedEvent()
  delete fixture.rawTransaction
  const result = parsedTransactionSummary(fixture, false)
  expect(result.net_balance_changes).toBeNull()
  expect(result).not.toHaveProperty('instructions')
  expect(result.transfers).toHaveLength(2)
})

test('mainnet rejects truncated batches, wrong-order and malformed parser responses', async () => {
  for (const payload of [
    [],
    { data: [parsedEvent()] },
    [parsedEvent(1)],
    [{ signature: testSignature(), parserStatus: 'OK', parsed: {} }],
    [{ signature: testSignature(), parserStatus: 'OTHER' }],
  ])
    expect(
      await runHeliusTool(
        'get_transactions',
        { signatures: [testSignature()] },
        { rpcUrl, fetch: response(payload) },
      ),
    ).toMatchObject({ error: { code: 'upstream_error' } })
})

test('all mainnet numeric values remain exact after lossless JSON parsing', async () => {
  const payload = JSON.stringify([parsedEvent()])
    .replace(
      '"rawTokenAmount":"18446744073709551615"',
      '"rawTokenAmount":18446744073709551615',
    )
    .replace('"slot":50', '"slot":18446744073709551615')
  const fetcher = (async () => new Response(payload)) as unknown as typeof fetch
  const out = await runHeliusTool(
    'get_transactions',
    { signatures: [testSignature()] },
    { rpcUrl, fetch: fetcher },
  )
  expect(out).toMatchObject({
    ok: true,
    result: {
      transactions: [
        {
          slot: '18446744073709551615',
          transfers: [{ amount: '1' }, { amount: '18446744073709.551615' }],
        },
      ],
    },
  })
  expect(() => JSON.stringify(out)).not.toThrow()
})

test('transaction execution status uses explicit metadata, then signature status, otherwise unknown', () => {
  const raw = { ...rawTransaction(), meta: null }
  expect(
    transactionSummary(
      testSignature(),
      raw,
      { err: { InstructionError: [0, 'InvalidArgument'] } },
      false,
    ),
  ).toMatchObject({
    status: 'failed',
    error: { InstructionError: [0, 'InvalidArgument'] },
  })
  expect(transactionSummary(testSignature(), raw, null, false)).toMatchObject({
    status: 'unknown',
    error: null,
  })
  expect(
    transactionSummary(testSignature(), raw, { err: null }, false),
  ).toMatchObject({ status: 'succeeded' })
  expect(
    transactionSummary(
      testSignature(),
      rawTransaction(),
      { err: 'stale' },
      false,
    ),
  ).toMatchObject({ status: 'succeeded', error: null })
})

test('malformed raw balance arrays never produce partial invented net changes', () => {
  for (const mutate of [
    (fixture: ReturnType<typeof parsedEvent>) => {
      fixture.rawTransaction.meta.postBalances.pop()
    },
    (fixture: ReturnType<typeof parsedEvent>) => {
      fixture.rawTransaction.meta.loadedAddresses.writable = []
    },
  ]) {
    const fixture = parsedEvent()
    mutate(fixture)
    expect(() => parsedTransactionSummary(fixture, false)).toThrow()
  }
})
