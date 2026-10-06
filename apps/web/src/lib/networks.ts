// Each network pairs a label and wallet-standard chain ID with the USDC mint
// that exists on it. Sending USDC on the wrong network loses it, so the page
// always names the network. Balances come from the API, which reports the
// network it reads.
export const NETWORKS = {
  devnet: {
    label: 'Solana devnet',
    chain: 'solana:devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
  mainnet: {
    label: 'Solana mainnet',
    chain: 'solana:mainnet',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
} as const

export type NetworkId = keyof typeof NETWORKS

export function isNetworkId(value: string): value is NetworkId {
  return Object.hasOwn(NETWORKS, value)
}

/**
 * Checks the build-time network setting. Builds must name a network: a
 * default could show devnet labels on a mainnet page, where real deposits
 * would go to the wrong place.
 */
export function checkNetworkEnv(env: Record<string, string | undefined>) {
  const id = env.VITE_SOLANA_NETWORK
  if (!id || !isNetworkId(id)) {
    throw new Error(
      `Set VITE_SOLANA_NETWORK to one of ${Object.keys(NETWORKS).join(', ')}`,
    )
  }
  return { id }
}
