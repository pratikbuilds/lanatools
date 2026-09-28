const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

// Each network pairs an RPC with the USDC mint that exists on it. Sending
// USDC on the wrong network loses it, so the page always names the network.
// The genesis hash and Surfpool marker let the page confirm that an RPC
// really serves the network it is labelled as.
export const NETWORKS = {
  sandbox: {
    label: 'Surfpool sandbox',
    rpcURL: 'https://402.surfnet.dev:8899',
    // Surfpool forks mainnet: same genesis hash and USDC mint.
    usdcMint: MAINNET_USDC,
    genesisHash: MAINNET_GENESIS,
    surfpool: true,
  },
  devnet: {
    label: 'Solana devnet',
    rpcURL: 'https://api.devnet.solana.com',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    surfpool: false,
  },
  mainnet: {
    label: 'Solana mainnet',
    // The public mainnet RPC refuses token-account queries, so mainnet
    // needs VITE_SOLANA_RPC_URL.
    rpcURL: null,
    usdcMint: MAINNET_USDC,
    genesisHash: MAINNET_GENESIS,
    surfpool: false,
  },
} as const

export type NetworkId = keyof typeof NETWORKS

export function isNetworkId(value: string): value is NetworkId {
  return Object.hasOwn(NETWORKS, value)
}

/**
 * Checks the build-time network settings. Builds must name a network: a
 * default could show sandbox balances on a production page, where real
 * deposits would never appear.
 */
export function checkNetworkEnv(env: Record<string, string | undefined>) {
  const id = env.VITE_SOLANA_NETWORK
  if (!id || !isNetworkId(id)) {
    throw new Error(
      `Set VITE_SOLANA_NETWORK to one of ${Object.keys(NETWORKS).join(', ')}`,
    )
  }
  const rpcURL = env.VITE_SOLANA_RPC_URL ?? NETWORKS[id].rpcURL
  if (!rpcURL) {
    throw new Error(`Set VITE_SOLANA_RPC_URL for ${NETWORKS[id].label}`)
  }
  return { id, rpcURL }
}
