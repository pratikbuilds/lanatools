import { expect, mock, test } from 'bun:test'
import { createPaymentConfig, paymentConfig } from '../payments/network'
import { SOLANA_NETWORKS, solanaConfig } from './network'

const DEVNET = {
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://devnet.example/?api-key=private-key',
}
const MAINNET = {
  SOLANA_NETWORK: 'mainnet',
  SOLANA_RPC_URL: 'https://mainnet.example/?api-key=private-key',
}

test('read config resolves devnet and mainnet without an RPC probe', async () => {
  for (const [env, network] of [
    [DEVNET, SOLANA_NETWORKS.devnet],
    [MAINNET, SOLANA_NETWORKS.mainnet],
  ] as const) {
    expect(await solanaConfig(env)).toEqual({
      network,
      rpcUrl: env.SOLANA_RPC_URL,
    })
  }
})

test('concurrent calls share a successful verification and changed RPCs recheck', async () => {
  const read = mock(async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
  const config = createPaymentConfig(read)
  await Promise.all([config(DEVNET), config(DEVNET), config(DEVNET)])
  expect(read).toHaveBeenCalledTimes(1)
  await config({ ...DEVNET, SOLANA_RPC_URL: 'https://other.example' })
  expect(read).toHaveBeenCalledTimes(2)
})

test('network mismatch is refused and a failed verification is retried', async () => {
  const read = mock(async () => 'wrong-cluster')
  const config = createPaymentConfig(read)
  await expect(config(DEVNET)).rejects.toThrow('does not match SOLANA_NETWORK')
  read.mockImplementation(
    async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  )
  expect((await config(DEVNET)).network.name).toBe('devnet')
  expect(read).toHaveBeenCalledTimes(2)
})

test('a failed old request cannot invalidate a newer successful verification', async () => {
  let rejectOld: (error: Error) => void = () => undefined
  const pending = new Promise<string>((_resolve, reject) => {
    rejectOld = reject
  })
  const read = mock((url: string) =>
    url === DEVNET.SOLANA_RPC_URL
      ? pending
      : Promise.resolve('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
  )
  const config = createPaymentConfig(read)
  const old = config(DEVNET)
  await config({ ...DEVNET, SOLANA_RPC_URL: 'https://other.example' })
  rejectOld(new Error('old failed'))
  await expect(old).rejects.toThrow('Could not verify')
  await config({ ...DEVNET, SOLANA_RPC_URL: 'https://other.example' })
  expect(read).toHaveBeenCalledTimes(2)
})

test('RPC exceptions are redacted and unsupported labels never make a request', async () => {
  const read = mock(async (): Promise<string> => {
    throw new Error(DEVNET.SOLANA_RPC_URL)
  })
  const config = createPaymentConfig(read)
  await expect(config(DEVNET)).rejects.toThrow(
    'Could not verify the Solana RPC network',
  )
  for (const name of [
    'testnet',
    'mainnet-beta',
    '__proto__',
    DEVNET.SOLANA_RPC_URL,
  ])
    await expect(
      solanaConfig({ ...DEVNET, SOLANA_NETWORK: name }),
    ).rejects.toThrow('Unsupported SOLANA_NETWORK')
  await expect(solanaConfig({ ...DEVNET, SOLANA_RPC_URL: '' })).rejects.toThrow(
    'Set SOLANA_RPC_URL',
  )
  expect(read).toHaveBeenCalledTimes(1)
})

test('payments still reject mainnet before contacting an RPC', async () => {
  for (const network of ['mainnet', 'mainnet-beta', 'testnet'])
    await expect(
      paymentConfig({ SOLANA_NETWORK: network, SOLANA_RPC_URL: 'not-a-url' }),
    ).rejects.toThrow('Payments only support Solana devnet')
})
