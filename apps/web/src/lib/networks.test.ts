import { expect, test } from 'bun:test'
import { checkNetworkEnv } from './networks'

test('builds must name a known network', () => {
  expect(() => checkNetworkEnv({})).toThrow('Set VITE_SOLANA_NETWORK')
  expect(() => checkNetworkEnv({ VITE_SOLANA_NETWORK: 'testnet' })).toThrow(
    'Set VITE_SOLANA_NETWORK',
  )
})

test('mainnet needs its own RPC URL', () => {
  expect(() => checkNetworkEnv({ VITE_SOLANA_NETWORK: 'mainnet' })).toThrow(
    'Set VITE_SOLANA_RPC_URL',
  )
  expect(
    checkNetworkEnv({
      VITE_SOLANA_NETWORK: 'mainnet',
      VITE_SOLANA_RPC_URL: 'https://rpc.example',
    }),
  ).toEqual({ id: 'mainnet', rpcURL: 'https://rpc.example' })
})

test('sandbox and devnet use their public RPCs by default', () => {
  expect(checkNetworkEnv({ VITE_SOLANA_NETWORK: 'sandbox' }).rpcURL).toBe(
    'https://402.surfnet.dev:8899',
  )
  expect(checkNetworkEnv({ VITE_SOLANA_NETWORK: 'devnet' }).rpcURL).toBe(
    'https://api.devnet.solana.com',
  )
})
