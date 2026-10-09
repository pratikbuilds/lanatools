import { expect, mock, test } from 'bun:test'
import {
  SOLANA_NETWORKS as NETWORKS,
  parseSolanaNetwork,
  readSolanaNetwork,
  solanaExplorerTransactionUrl,
} from '@lanatools/contracts/networks'
import {
  SOLANA_NETWORKS,
  createPaymentConfig,
  paymentConfig,
  solanaConfig,
} from './network'

const DEVNET = {
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://devnet.example/?api-key=private-key',
}
const MAINNET = {
  SOLANA_NETWORK: 'mainnet',
  SOLANA_RPC_URL: 'https://mainnet.example/?api-key=private-key',
}

test('the shared deployment selector switches all public metadata and rejects missing or unsupported values', () => {
  for (const network of ['devnet', 'mainnet'] as const) {
    expect(readSolanaNetwork({ SOLANA_NETWORK: network })).toBe(network)
    expect(parseSolanaNetwork(network)).toBe(network)
    const metadata = NETWORKS[network]
    expect(metadata.name).toBe(network)
    expect(String(metadata.caip2)).toBe(
      `solana:${metadata.genesisHash.slice(0, 32)}`,
    )
    expect(metadata.chain).toBe(`solana:${network}`)
  }
  expect(NETWORKS.devnet.publicRpcUrl).toBe('https://api.devnet.solana.com')
  expect(NETWORKS.mainnet.publicRpcUrl).toBe(
    'https://api.mainnet-beta.solana.com',
  )
  expect(NETWORKS.devnet.explorerCluster).toBe('devnet')
  expect(NETWORKS.mainnet.explorerCluster).toBeUndefined()
  expect(NETWORKS.devnet.walletAdapterNetwork).toBe('Devnet')
  expect(NETWORKS.mainnet.walletAdapterNetwork).toBe('Mainnet')
  expect(NETWORKS.devnet.isTestNetwork).toBe(true)
  expect(NETWORKS.mainnet.isTestNetwork).toBe(false)
  expect(solanaExplorerTransactionUrl('devnet', 'signature')).toBe(
    'https://explorer.solana.com/tx/signature?cluster=devnet',
  )
  expect(solanaExplorerTransactionUrl('mainnet', 'signature')).toBe(
    'https://explorer.solana.com/tx/signature',
  )
  expect(
    solanaExplorerTransactionUrl('mainnet', 'signature?cluster=devnet'),
  ).toBe('https://explorer.solana.com/tx/signature%3Fcluster%3Ddevnet')
  expect(() => readSolanaNetwork({})).toThrow('SOLANA_NETWORK')
  for (const value of [
    undefined,
    null,
    '',
    'mainnet-beta',
    'testnet',
    '__proto__',
    'constructor',
    ' mainnet',
    1,
  ])
    expect(() => parseSolanaNetwork(value)).toThrow(
      'Unsupported SOLANA_NETWORK',
    )
})

test('changing deployment network rechecks the same RPC and refuses a stale cluster', async () => {
  let genesis = NETWORKS.devnet.genesisHash as string
  const read = mock(async () => genesis)
  const config = createPaymentConfig(read)
  await config(DEVNET)
  const switched = { ...DEVNET, SOLANA_NETWORK: 'mainnet' }
  await expect(config(switched)).rejects.toThrow(
    'does not match SOLANA_NETWORK',
  )
  expect(read).toHaveBeenCalledTimes(2)
  genesis = NETWORKS.mainnet.genesisHash
  expect((await config(switched)).network).toEqual({
    name: 'mainnet',
    usdcMint: NETWORKS.mainnet.usdcMint,
    genesisHash: NETWORKS.mainnet.genesisHash,
    caip2: NETWORKS.mainnet.caip2,
  })
  expect(read).toHaveBeenCalledTimes(3)
})

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

test('payments use the network SOLANA_NETWORK names, verified by genesis hash', async () => {
  const read = mock(async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
  const config = createPaymentConfig(read)
  expect(await config(MAINNET)).toEqual({
    network: {
      name: 'mainnet',
      genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },
    rpcUrl: MAINNET.SOLANA_RPC_URL,
  })
  // A devnet RPC configured as mainnet never pays.
  await expect(
    createPaymentConfig(
      async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    )(MAINNET),
  ).rejects.toThrow('does not match SOLANA_NETWORK')
})

test('payments reject unknown networks before contacting an RPC', async () => {
  for (const network of ['mainnet-beta', 'testnet'])
    await expect(
      paymentConfig({ SOLANA_NETWORK: network, SOLANA_RPC_URL: 'not-a-url' }),
    ).rejects.toThrow('Unsupported SOLANA_NETWORK')
})
