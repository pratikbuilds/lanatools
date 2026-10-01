import { createSolanaRpc } from '@solana/kit'

/** How long one RPC request may take. */
export const RPC_TIMEOUT_MS = 10_000

/**
 * The one Solana network agent payments run on. Everything network-specific
 * lives here; mainnet is deliberately absent until it is launched.
 */
export type PaymentNetwork = {
  /** The network name MPP challenges and Pay Kit permissions use. */
  name: 'devnet'
  /** The CAIP-2 ID x402 challenges use. */
  caip2: string
  genesisHash: string
  /** Circle's USDC on this network, the only token LanaTools pays with. */
  usdcMint: string
}

const NETWORKS: Record<string, PaymentNetwork> = {
  devnet: {
    name: 'devnet',
    caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  },
}

export type PaymentEnv = {
  SOLANA_NETWORK: string
  /**
   * Must not be api.devnet.solana.com: the public RPC refuses Workers
   * (any request with a CF-Worker header) with HTTP 403.
   */
  SOLANA_RPC_URL: string
}

export type PaymentConfig = { network: PaymentNetwork; rpcUrl: string }

// Checked once per isolate; a failed check is retried on the next call.
let verified: Promise<void> | undefined
let verifiedFor: string | undefined

/**
 * Resolves the configured network and proves the RPC serves it. A mainnet
 * RPC behind a devnet label could spend real funds, so a mismatch refuses
 * every payment rather than warning.
 */
export async function paymentConfig(env: PaymentEnv): Promise<PaymentConfig> {
  const network = NETWORKS[env.SOLANA_NETWORK]
  if (!network)
    throw new Error(`Unsupported SOLANA_NETWORK ${env.SOLANA_NETWORK}`)
  if (!env.SOLANA_RPC_URL) throw new Error('Set SOLANA_RPC_URL')
  const key = `${network.name} ${env.SOLANA_RPC_URL}`
  if (verifiedFor !== key || !verified) {
    verifiedFor = key
    verified = assertGenesis(env.SOLANA_RPC_URL, network).catch(
      (error: unknown) => {
        verified = undefined
        throw error
      },
    )
  }
  await verified
  return { network, rpcUrl: env.SOLANA_RPC_URL }
}

async function assertGenesis(rpcUrl: string, network: PaymentNetwork) {
  const genesis = await createSolanaRpc(rpcUrl)
    .getGenesisHash()
    .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  if (genesis !== network.genesisHash)
    throw new Error(
      `SOLANA_RPC_URL does not serve Solana ${network.name}; refusing to pay`,
    )
}
