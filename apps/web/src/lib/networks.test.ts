import { expect, test } from 'bun:test'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import { NETWORKS, checkNetworkEnv } from './networks'

test('web and server share network metadata and one explicit network setting', () => {
  expect(NETWORKS).toBe(SOLANA_NETWORKS)
  for (const SOLANA_NETWORK of [undefined, '', 'testnet', 'sandbox'])
    expect(() => checkNetworkEnv({ SOLANA_NETWORK })).toThrow('SOLANA_NETWORK')
  expect(checkNetworkEnv({ SOLANA_NETWORK: 'mainnet' })).toEqual({
    id: 'mainnet',
  })
  expect(checkNetworkEnv({ SOLANA_NETWORK: 'devnet' })).toEqual({
    id: 'devnet',
  })
})

test('the retired Vite network variable cannot override the deployment network', () => {
  expect(() => checkNetworkEnv({ VITE_SOLANA_NETWORK: 'mainnet' })).toThrow(
    'SOLANA_NETWORK',
  )
  expect(
    checkNetworkEnv({
      SOLANA_NETWORK: 'devnet',
      VITE_SOLANA_NETWORK: 'mainnet',
    }),
  ).toEqual({ id: 'devnet' })
})
