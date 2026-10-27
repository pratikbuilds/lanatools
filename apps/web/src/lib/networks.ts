import {
  SOLANA_NETWORKS as NETWORKS,
  readSolanaNetwork,
} from '@lanatools/contracts/networks'

export { NETWORKS }
export type { NetworkId } from '@lanatools/contracts/networks'

/** The browser receives only the deployment's selected network from Vite. */
export function checkNetworkEnv(env: Record<string, string | undefined>) {
  return { id: readSolanaNetwork(env) }
}

/** The network this build shows, without pulling in a Solana client. */
export function selectedNetwork() {
  const { id } = checkNetworkEnv({
    SOLANA_NETWORK:
      import.meta.env.SOLANA_NETWORK ??
      (process.env.NODE_ENV === 'test' ? 'devnet' : undefined),
  })
  return { ...NETWORKS[id], id }
}
