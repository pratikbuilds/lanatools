/** Public network metadata. Provider RPC credentials belong in server configuration. */
export const SOLANA_NETWORKS = {
  devnet: {
    name: 'devnet',
    label: 'Solana devnet',
    chain: 'solana:devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    publicRpcUrl: 'https://api.devnet.solana.com',
    isTestNetwork: true,
    explorerBaseUrl: 'https://explorer.solana.com',
    explorerCluster: 'devnet',
    walletAdapterNetwork: 'Devnet',
  },
  mainnet: {
    name: 'mainnet',
    label: 'Solana mainnet',
    chain: 'solana:mainnet',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    publicRpcUrl: 'https://api.mainnet-beta.solana.com',
    isTestNetwork: false,
    explorerBaseUrl: 'https://explorer.solana.com',
    explorerCluster: undefined,
    walletAdapterNetwork: 'Mainnet',
  },
} as const

export type NetworkId = keyof typeof SOLANA_NETWORKS

export function solanaExplorerTransactionUrl(
  network: NetworkId,
  signature: string,
): string {
  const metadata = SOLANA_NETWORKS[network]
  const cluster = metadata.explorerCluster
  return `${metadata.explorerBaseUrl}/tx/${encodeURIComponent(signature)}${cluster ? `?cluster=${encodeURIComponent(cluster)}` : ''}`
}

export function parseSolanaNetwork(value: unknown): NetworkId {
  if (value === 'devnet' || value === 'mainnet') return value
  throw new Error('Unsupported SOLANA_NETWORK; set it to devnet or mainnet')
}

/** Select the deployment network explicitly, without a fallback cluster. */
export function readSolanaNetwork(env: {
  SOLANA_NETWORK?: string | undefined
}): NetworkId {
  return parseSolanaNetwork(env.SOLANA_NETWORK)
}
