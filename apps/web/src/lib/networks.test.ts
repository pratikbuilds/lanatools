import { expect, test } from 'bun:test'
import { checkNetworkEnv } from './networks'

test('builds must name a known network', () => {
  for (const VITE_SOLANA_NETWORK of [undefined, 'testnet', 'sandbox'])
    expect(() => checkNetworkEnv({ VITE_SOLANA_NETWORK })).toThrow(
      'Set VITE_SOLANA_NETWORK',
    )
  expect(checkNetworkEnv({ VITE_SOLANA_NETWORK: 'mainnet' })).toEqual({
    id: 'mainnet',
  })
  expect(checkNetworkEnv({ VITE_SOLANA_NETWORK: 'devnet' })).toEqual({
    id: 'devnet',
  })
})
