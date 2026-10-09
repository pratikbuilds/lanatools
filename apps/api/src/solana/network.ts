import { createSolanaRpc } from '@solana/kit'
import {
  SOLANA_NETWORKS as NETWORKS,
  readSolanaNetwork,
} from '@lanatools/contracts/networks'

/**
 * Server configuration using shared network metadata from contracts.
 * Read tools use `solanaConfig`; payments use `paymentConfig`,
 * which also proves the RPC serves the network before funds can move.
 */

/** How long one RPC request may take. */
export const RPC_TIMEOUT_MS = 10_000

export const SOLANA_NETWORKS = {
  devnet: { name: NETWORKS.devnet.name },
  mainnet: { name: NETWORKS.mainnet.name },
} as const

export type SolanaNetwork =
  (typeof SOLANA_NETWORKS)[keyof typeof SOLANA_NETWORKS]
export type SolanaEnv = {
  SOLANA_NETWORK: string
  /** Server-only RPC URL; it may contain a provider key. */
  SOLANA_RPC_URL: string
}
export type SolanaConfig = { network: SolanaNetwork; rpcUrl: string }

/** A network LanaTools pays on: the one SOLANA_NETWORK names. */
export type PaymentNetwork = {
  /** The network name MPP challenges and Pay Kit permissions use. */
  name: SolanaNetwork['name']
  /** The CAIP-2 ID x402 challenges use. */
  caip2: string
  genesisHash: string
  /** Circle's USDC on this network, the only token LanaTools pays with. */
  usdcMint: string
}
export type PaymentConfig = { network: PaymentNetwork; rpcUrl: string }

function paymentNetwork(
  network: (typeof NETWORKS)[SolanaNetwork['name']],
): PaymentNetwork {
  const { name, genesisHash: genesis, caip2, usdcMint } = network
  return { name, genesisHash: genesis, caip2, usdcMint }
}

export const PAYMENT_NETWORKS: Record<SolanaNetwork['name'], PaymentNetwork> = {
  devnet: paymentNetwork(NETWORKS.devnet),
  mainnet: paymentNetwork(NETWORKS.mainnet),
}

function readRPCURL(env: SolanaEnv) {
  if (!env.SOLANA_RPC_URL) throw new Error('Set SOLANA_RPC_URL')
  return env.SOLANA_RPC_URL
}

/** Read tools use the server configuration without an extra RPC probe. */
export async function solanaConfig(env: SolanaEnv): Promise<SolanaConfig> {
  return {
    network: SOLANA_NETWORKS[readSolanaNetwork(env)],
    rpcUrl: readRPCURL(env),
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
    const network = PAYMENT_NETWORKS[readSolanaNetwork(env)]
    const url = readRPCURL(env)
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

/** Payments verify the RPC serves their network before funds can move. */
export const paymentConfig = createPaymentConfig()
