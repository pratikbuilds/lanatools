import { expect, test } from 'bun:test'
import { webDeploymentEnv } from './build-deployment-web'

test('web deployment follows the API target even when local configuration selects another network', () => {
  for (const target of ['mainnet', 'devnet'] as const) {
    const config = `{// deployment config\n"vars":{"SOLANA_NETWORK":"${target}",},}`
    const env = webDeploymentEnv(config, {
      SOLANA_NETWORK: target === 'mainnet' ? 'devnet' : 'mainnet',
      VITE_PRIVY_APP_ID: 'public-app-id',
    })
    expect(env.SOLANA_NETWORK).toBe(target)
    expect(env.VITE_PRIVY_APP_ID).toBe('public-app-id')
  }
})

test('missing or unsupported deployment networks cannot fall back to local settings', () => {
  for (const config of [
    '{}',
    '{"vars":{}}',
    '{"vars":{"SOLANA_NETWORK":"testnet"}}',
  ])
    expect(() =>
      webDeploymentEnv(config, { SOLANA_NETWORK: 'mainnet' }),
    ).toThrow('SOLANA_NETWORK')
})
