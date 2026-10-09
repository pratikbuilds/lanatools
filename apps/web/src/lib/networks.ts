import { readSolanaNetwork } from '@lanatools/contracts/networks'

export { SOLANA_NETWORKS as NETWORKS } from '@lanatools/contracts/networks'
export type { NetworkId } from '@lanatools/contracts/networks'

/** The browser receives only the deployment's selected network from Vite. */
export function checkNetworkEnv(env: Record<string, string | undefined>) {
  return { id: readSolanaNetwork(env) }
}
