import { expect, test } from 'bun:test'
import {
  PRODUCTION_PRIVY_APP_ID,
  checkLocalConfig,
  checkLocalEnv,
  parseUsdc,
} from './local-env'

const env = {
  PRIVY_APP_ID: 'local-app',
  PRIVY_APP_SECRET: 'secret',
  PRIVY_PAYMENT_SIGNER_ID: 'signer',
  PRIVY_PAYMENT_SIGNER_KEY: 'key',
  SOLANA_RPC_URL: 'https://devnet.example.com/?api-key=k',
}

test('accepts complete local secrets', () => {
  expect(checkLocalEnv(env)).toEqual([])
})

test('names every missing secret', () => {
  expect(
    checkLocalEnv({ ...env, PRIVY_APP_SECRET: '', SOLANA_RPC_URL: undefined }),
  ).toEqual(['Set PRIVY_APP_SECRET, SOLANA_RPC_URL in .env (see .env.example)'])
})

test('refuses the production Privy app', () => {
  expect(
    checkLocalEnv({ ...env, PRIVY_APP_ID: PRODUCTION_PRIVY_APP_ID }),
  ).toEqual([
    'PRIVY_APP_ID is the production Privy app; use a separate app for local development',
  ])
})

test("refuses Solana's public devnet RPC, which Workers cannot use", () => {
  expect(
    checkLocalEnv({ ...env, SOLANA_RPC_URL: 'https://api.devnet.solana.com' }),
  ).toHaveLength(1)
})

test('accepts the checked-in local Wrangler configs', async () => {
  for (const path of [
    'apps/api/wrangler.local.jsonc',
    'apps/mcp/wrangler.local.jsonc',
  ])
    expect(checkLocalConfig(path, await Bun.file(path).text())).toEqual([])
})

test('refuses remote bindings and a non-devnet network', () => {
  expect(
    checkLocalConfig(
      'c',
      '{ "d1_databases": [{ "binding": "DB", "remote": true }] }',
    ),
  ).toEqual(['c has a remote binding; local bindings must stay local'])
  expect(
    checkLocalConfig('c', '{ "vars": { "SOLANA_NETWORK": "mainnet" } }'),
  ).toEqual(['c must set SOLANA_NETWORK to devnet'])
})

test('parses USDC amounts into base units', () => {
  expect(parseUsdc('1')).toBe(1_000_000n)
  expect(parseUsdc('0.5')).toBe(500_000n)
  expect(parseUsdc('0.000001')).toBe(1n)
  for (const bad of ['0', '-1', '1.0000001', 'abc', ''])
    expect(() => parseUsdc(bad)).toThrow()
})
