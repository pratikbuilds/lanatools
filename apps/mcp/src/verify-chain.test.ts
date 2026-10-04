import { expect, test } from 'bun:test'
import { heliusTools } from '@lanatools/helius'
import {
  assertNoSecrets,
  assertToolLedger,
  chainFixtures,
} from '../scripts/verify-chain'

const signature = '1'.repeat(64)

test('every exported Helius tool has a schema-valid devnet fixture without caller-selected network', () => {
  const fixtures = chainFixtures({ LANATOOLS_DEVNET_SIGNATURE: signature })
  expect([...fixtures.keys()]).toEqual(heliusTools.map((tool) => tool.name))
  for (const [name, fixture] of fixtures) {
    expect(fixture.input).not.toHaveProperty('network')
    expect(
      heliusTools
        .find((tool) => tool.name === name)
        ?.input.safeParse(fixture.input).success,
    ).toBe(true)
  }
  expect(() => chainFixtures({})).toThrow('LANATOOLS_DEVNET_SIGNATURE')
})

test('transaction verification requires an existing shaped transaction, not an empty lookup', () => {
  const fixture = chainFixtures({ LANATOOLS_DEVNET_SIGNATURE: signature }).get(
    'get_transactions',
  )!
  expect(fixture.output.safeParse({ transactions: [] }).success).toBe(false)
  expect(
    fixture.output.safeParse({ transactions: [{ signature, found: false }] })
      .success,
  ).toBe(false)
  expect(
    fixture.output.safeParse({
      transactions: [
        {
          signature,
          found: true,
          status: 'succeeded',
          fee_sol: '0.000005',
          transfers: [],
          programs: [],
        },
      ],
    }).success,
  ).toBe(true)
})

test('ledger verification requires exactly one successful credited devnet row per call', () => {
  const names = heliusTools.map((tool) => tool.name)
  const rows = names.map((tool) => ({
    tool,
    network: 'devnet',
    status: 'ok',
    credits: 1,
    error_code: null,
  }))
  expect(() => assertToolLedger(rows, names)).not.toThrow()
  expect(() => assertToolLedger(rows.slice(1), names)).toThrow()
  expect(() => assertToolLedger([...rows, rows[0]], names)).toThrow()
  expect(() =>
    assertToolLedger(
      rows.map((row) => ({ ...row, network: 'mainnet' })),
      names,
    ),
  ).toThrow()
  expect(() =>
    assertToolLedger(
      rows.map((row) => ({ ...row, credits: 0 })),
      names,
    ),
  ).toThrow()
  expect(() =>
    assertToolLedger(
      rows.map((row) => ({ ...row, status: 'failed', error_code: 'timeout' })),
      names,
    ),
  ).toThrow()
})

test('secrecy checks scan raw and encoded keys and provider credential URLs without echoing them', () => {
  expect(() => assertNoSecrets({ accounts: [] }, ['secret'])).not.toThrow()
  expect(() => assertNoSecrets('secret', ['secret'])).toThrow('Secret found')
  expect(() => assertNoSecrets('key%2Bvalue', ['key+value'])).toThrow(
    'Secret found',
  )
  expect(() =>
    assertNoSecrets('https://example.test/?api-key=hidden', []),
  ).toThrow('Provider credential URL found')
  try {
    assertNoSecrets('never-echo-this', ['never-echo-this'])
  } catch (error) {
    expect(String(error)).not.toContain('never-echo-this')
  }
})
