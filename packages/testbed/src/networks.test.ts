import { describe, expect, test } from 'bun:test'
import { profiles, selectProfile } from './networks'

describe('selectProfile', () => {
  test('defaults to the sandbox', () => {
    expect(selectProfile()).toBe(profiles.sandbox)
  })

  test('rejects an unknown network rather than guessing', () => {
    expect(() => selectProfile('mainnet')).toThrow('Unknown network')
  })

  test('keeps each network on its own mint, RPC, and state', () => {
    const { sandbox, devnet } = profiles
    expect(sandbox.network).toBe('localnet')
    expect(devnet.network).toBe('devnet')
    expect(devnet.usdcMint).not.toBe(sandbox.usdcMint)
    expect(devnet.rpcUrl).not.toBe(sandbox.rpcUrl)
    expect(devnet.stateDir).not.toBe(sandbox.stateDir)
    // Only the disposable sandbox state may be wiped.
    expect(sandbox.resetState).toBe(true)
    expect(devnet.resetState).toBe(false)
  })
})
