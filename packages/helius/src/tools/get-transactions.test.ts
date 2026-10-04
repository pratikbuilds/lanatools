import { expect, test } from 'bun:test'
import { runHeliusTool } from '../index'
import {
  rawTransaction,
  testSignature,
} from '../fixtures/parsed-events-synthetic'

const rpcUrl = 'https://devnet.helius-rpc.com/?api-key=SYNTHETIC_SECRET'
function mock(statuses: unknown, transaction: unknown): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        result: method === 'getSignatureStatuses' ? statuses : transaction,
      }),
    )
  }) as typeof fetch
}
test('devnet rejects malformed signature-status values/cardinality before treating null transactions as missing', async () => {
  for (const statuses of [
    null,
    {},
    { value: null },
    { value: [] },
    { value: [null, null] },
    { value: [123] },
    { value: ['oops'] },
    { value: [[]] },
  ])
    expect(
      await runHeliusTool(
        'get_transactions',
        { signatures: [testSignature()] },
        { rpcUrl, fetch: mock(statuses, null) },
      ),
    ).toMatchObject({ error: { code: 'upstream_error' } })
})
test('only explicit null transaction is missing; malformed transaction/message shapes fail safely', async () => {
  for (const tx of [
    undefined,
    false,
    0,
    '',
    'echoed secret',
    {},
    { transaction: {} },
    { transaction: { message: {} } },
    {
      transaction: { message: { accountKeys: [], instructions: [] } },
      meta: 'bad',
    },
  ])
    expect(
      await runHeliusTool(
        'get_transactions',
        { signatures: [testSignature()] },
        { rpcUrl, fetch: mock({ value: [null] }, tx) },
      ),
    ).toMatchObject({ error: { code: 'upstream_error' } })
  expect(
    await runHeliusTool(
      'get_transactions',
      { signatures: [testSignature()] },
      { rpcUrl, fetch: mock({ value: [null] }, null) },
    ),
  ).toMatchObject({ ok: true, result: { transactions: [{ found: false }] } })
})
test('devnet metadata-null transaction reports signature failure or unknown correctly', async () => {
  for (const [status, expected] of [
    [{ err: 'failed', confirmationStatus: 'confirmed' }, 'failed'],
    [null, 'unknown'],
  ] as const) {
    const out = await runHeliusTool(
      'get_transactions',
      { signatures: [testSignature()] },
      {
        rpcUrl,
        fetch: mock({ value: [status] }, { ...rawTransaction(), meta: null }),
      },
    )
    expect(out).toMatchObject({
      ok: true,
      result: { transactions: [{ status: expected }] },
    })
  }
})
