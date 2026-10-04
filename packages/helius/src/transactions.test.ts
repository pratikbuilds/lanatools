import { expect, test } from 'bun:test'
import {
  owner,
  parsedEvent,
  rawTransaction,
  testSignature,
} from './fixtures/parsed-events-synthetic'
import { runHeliusTool } from './index'
import { netBalanceChanges } from './transactions'

test('unavailable token balances retain exact SOL changes without inventing token changes', () => {
  const fixture = rawTransaction()
  const sol = netBalanceChanges(fixture).sol
  const before = fixture.meta.preTokenBalances
  const after = fixture.meta.postTokenBalances
  for (const [preTokenBalances, postTokenBalances] of [
    [undefined, after],
    [null, after],
    [before, undefined],
    [before, null],
    [undefined, undefined],
    [null, null],
    [[], undefined],
    [null, []],
  ])
    expect(
      netBalanceChanges({
        ...fixture,
        meta: { ...fixture.meta, preTokenBalances, postTokenBalances },
      }),
    ).toEqual({ sol, tokens: null })
})

test('malformed token balance arrays fail even when the other side is unavailable', () => {
  const fixture = rawTransaction()
  for (const malformed of [0, false, '', {}, { amount: '1' }])
    for (const [preTokenBalances, postTokenBalances] of [
      [malformed, fixture.meta.postTokenBalances],
      [fixture.meta.preTokenBalances, malformed],
      [undefined, malformed],
      [malformed, null],
    ])
      expect(() =>
        netBalanceChanges({
          ...fixture,
          meta: { ...fixture.meta, preTokenBalances, postTokenBalances },
        }),
      ).toThrow(expect.objectContaining({ code: 'upstream_error' }))
})

test('explicit empty token arrays support zero changes and account creation or closure', () => {
  const fixture = rawTransaction()
  const sol = netBalanceChanges(fixture).sol
  expect(
    netBalanceChanges({
      ...fixture,
      meta: { ...fixture.meta, preTokenBalances: [], postTokenBalances: [] },
    }),
  ).toEqual({ sol, tokens: [] })
  expect(
    netBalanceChanges({
      ...fixture,
      meta: { ...fixture.meta, preTokenBalances: [] },
    }),
  ).toMatchObject({
    sol,
    tokens: [{ change_raw: '18446744073708551615' }],
  })
  expect(
    netBalanceChanges({
      ...fixture,
      meta: { ...fixture.meta, postTokenBalances: [] },
    }),
  ).toMatchObject({
    sol,
    tokens: [{ change_raw: '-18446744073709551615' }],
  })
})

test('history and Parsed Events expose unknown token deltas while preserving exact SOL', async () => {
  const fixture = rawTransaction()
  const raw = {
    ...fixture,
    meta: { ...fixture.meta, preTokenBalances: null },
  }
  const parsed = { ...parsedEvent(), rawTransaction: raw }
  const cases = [
    {
      tool: 'get_transaction_history',
      cluster: 'devnet',
      input: { address: owner },
      payload: { result: { data: [raw] } },
    },
    {
      tool: 'get_transaction_history',
      cluster: 'mainnet',
      input: { address: owner },
      payload: { data: [parsed] },
    },
    {
      tool: 'get_transactions',
      cluster: 'mainnet',
      input: { signatures: [testSignature()] },
      payload: [parsed],
    },
  ]
  for (const { tool, cluster, input, payload } of cases)
    expect(
      await runHeliusTool(tool, input, {
        rpcUrl: `https://${cluster}.helius-rpc.com/?api-key=SYNTHETIC_SECRET`,
        fetch: (async () =>
          new Response(JSON.stringify(payload))) as unknown as typeof fetch,
      }),
    ).toMatchObject({
      ok: true,
      result: {
        transactions: [
          {
            net_balance_changes: {
              sol: netBalanceChanges(fixture).sol,
              tokens: null,
            },
          },
        ],
      },
    })
})
