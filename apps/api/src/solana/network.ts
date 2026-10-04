/** How long one RPC request may take. */
export const RPC_TIMEOUT_MS = 10_000

export const SOLANA_NETWORKS = {
  devnet: {
    name: 'devnet',
  },
  mainnet: {
    name: 'mainnet',
  },
} as const

export type SolanaNetwork =
  (typeof SOLANA_NETWORKS)[keyof typeof SOLANA_NETWORKS]
export type SolanaEnv = {
  SOLANA_NETWORK: string
  /** Server-only RPC URL; it may contain a provider key. */
  SOLANA_RPC_URL: string
}
export type SolanaConfig = { network: SolanaNetwork; rpcUrl: string }

/** Read tools use the server configuration without an extra RPC probe. */
export async function solanaConfig(env: SolanaEnv): Promise<SolanaConfig> {
  if (env.SOLANA_NETWORK !== 'devnet' && env.SOLANA_NETWORK !== 'mainnet')
    throw new Error('Unsupported SOLANA_NETWORK')
  if (!env.SOLANA_RPC_URL) throw new Error('Set SOLANA_RPC_URL')
  return {
    network: SOLANA_NETWORKS[env.SOLANA_NETWORK],
    rpcUrl: env.SOLANA_RPC_URL,
  }
}
