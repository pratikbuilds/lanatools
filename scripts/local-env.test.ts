import { expect, test } from 'bun:test'
import {
  PRODUCTION_PRIVY_APP_ID,
  checkLocalConfig,
  checkLocalEnv,
  localStateDirectory,
  parseUsdc,
  requireDevnetFunding,
} from './local-env'

const env = {
  PRIVY_APP_ID: 'local-app',
  PRIVY_APP_SECRET: 'secret',
  PRIVY_PAYMENT_SIGNER_ID: 'signer',
  PRIVY_PAYMENT_SIGNER_KEY: 'key',
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://devnet.example.com/?api-key=k',
}

test('accepts complete local secrets', () => {
  expect(checkLocalEnv(env)).toEqual([])
  expect(
    checkLocalEnv({
      ...env,
      SOLANA_NETWORK: 'mainnet',
      SOLANA_RPC_URL: 'https://mainnet.example.com',
    }),
  ).toEqual([])
})

test('requires one explicit known network in root environment', () => {
  for (const SOLANA_NETWORK of [undefined, '', 'testnet', 'sandbox'])
    expect(checkLocalEnv({ ...env, SOLANA_NETWORK })).toContain(
      'Set SOLANA_NETWORK to devnet or mainnet in .env',
    )
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

test('refuses remote bindings and unknown networks while allowing mainnet', () => {
  expect(
    checkLocalConfig(
      'c',
      '{ "d1_databases": [{ "binding": "DB", "remote": true }] }',
    ),
  ).toEqual(['c has a remote binding; local bindings must stay local'])
  expect(
    checkLocalConfig('c', '{ "vars": { "SOLANA_NETWORK": "mainnet" } }'),
  ).toEqual([])
  for (const value of ['testnet', '', 'sandbox'])
    expect(
      checkLocalConfig(
        'c',
        JSON.stringify({ vars: { SOLANA_NETWORK: value } }),
      ),
    ).toEqual(['c must set SOLANA_NETWORK to devnet or mainnet'])
})

test('local storage preserves devnet history and isolates mainnet', () => {
  expect(localStateDirectory('devnet')).toBe('state')
  expect(localStateDirectory('mainnet')).toBe('state-mainnet')
})

test('the local funding command only permits an explicit devnet selection', () => {
  expect(() => requireDevnetFunding(env)).not.toThrow()
  expect(() =>
    requireDevnetFunding({ ...env, SOLANA_NETWORK: 'mainnet' }),
  ).toThrow('mainnet funding is disabled')
  expect(() =>
    requireDevnetFunding({ ...env, SOLANA_NETWORK: undefined }),
  ).toThrow('SOLANA_NETWORK')
})

test('parses USDC amounts into base units', () => {
  expect(parseUsdc('1')).toBe(1_000_000n)
  expect(parseUsdc('0.5')).toBe(500_000n)
  expect(parseUsdc('0.000001')).toBe(1n)
  for (const bad of ['0', '-1', '1.0000001', 'abc', ''])
    expect(() => parseUsdc(bad)).toThrow()
})
