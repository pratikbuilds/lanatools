import { createSolanaRpc } from '@solana/kit'

/**
 * Everything LanaTools knows about Solana networks and the server's network
 * configuration. Read tools use `solanaConfig`; payments use `paymentConfig`,
 * which also proves the RPC serves the network before funds can move.
 */

/** How long one RPC request may take. */
export const RPC_TIMEOUT_MS = 10_000

export const SOLANA_NETWORKS = {
  devnet: { name: 'devnet' },
  mainnet: { name: 'mainnet' },
} as const

export type SolanaNetwork =
  (typeof SOLANA_NETWORKS)[keyof typeof SOLANA_NETWORKS]
export type SolanaEnv = {
  SOLANA_NETWORK: string
  /** Server-only RPC URL; it may contain a provider key. */
  SOLANA_RPC_URL: string
}
export type SolanaConfig = { network: SolanaNetwork; rpcUrl: string }

/** Payments remain devnet-only even when read-only tools support mainnet. */
export type PaymentNetwork = {
  /** The network name MPP challenges and Pay Kit permissions use. */
  name: 'devnet'
  /** The CAIP-2 ID x402 challenges use. */
  caip2: string
  genesisHash: string
  /** Circle's USDC on this network, the only token LanaTools pays with. */
  usdcMint: string
}
export type PaymentConfig = { network: PaymentNetwork; rpcUrl: string }

const DEVNET_PAYMENTS: PaymentNetwork = {
  name: 'devnet',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
}

function rpcUrl(env: SolanaEnv) {
  if (!env.SOLANA_RPC_URL) throw new Error('Set SOLANA_RPC_URL')
  return env.SOLANA_RPC_URL
}

/** Read tools use the server configuration without an extra RPC probe. */
export async function solanaConfig(env: SolanaEnv): Promise<SolanaConfig> {
  if (env.SOLANA_NETWORK !== 'devnet' && env.SOLANA_NETWORK !== 'mainnet')
    throw new Error('Unsupported SOLANA_NETWORK')
  return {
    network: SOLANA_NETWORKS[env.SOLANA_NETWORK],
    rpcUrl: rpcUrl(env),
  }
}

type GenesisReader = (rpcUrl: string) => Promise<string>

/**
 * Shares one in-flight or successful verification per configured RPC. Failed
 * checks are retried on the next call. The injectable reader keeps tests off
 * the network; production uses Kit and a bounded request.
 */
export function createPaymentConfig(readGenesis: GenesisReader = genesisHash) {
  let cached: { key: string; verification: Promise<void> } | undefined
  return async (env: SolanaEnv): Promise<PaymentConfig> => {
    if (env.SOLANA_NETWORK !== 'devnet')
      throw new Error('Payments only support Solana devnet')
    const network = DEVNET_PAYMENTS
    const url = rpcUrl(env)
    const key = `${network.name} ${url}`
    if (cached?.key !== key) {
      const verification = (async () => {
        let genesis: string
        try {
          genesis = await readGenesis(url)
        } catch {
          // SDK errors may contain the complete URL and its provider key.
          throw new Error('Could not verify the Solana RPC network')
        }
        if (genesis !== network.genesisHash)
          throw new Error(
            'Solana RPC network does not match SOLANA_NETWORK; refusing to pay',
          )
      })()
      cached = { key, verification }
      void verification.catch(() => {
        // A failed old request must not clear a newer configuration's check.
        if (cached?.verification === verification) cached = undefined
      })
    }
    await cached.verification
    return { network, rpcUrl: url }
  }
}

async function genesisHash(rpcUrl: string) {
  return createSolanaRpc(rpcUrl)
    .getGenesisHash()
    .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
}

/** Payments verify the RPC serves devnet before allowing funds to move. */
export const paymentConfig = createPaymentConfig()
