import { createSolanaRpc } from '@solana/kit'
import { RPC_TIMEOUT_MS } from '../solana/network'
import type { SolanaEnv } from '../solana/network'

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

const DEVNET: PaymentNetwork = {
  name: 'devnet',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
}

export type PaymentEnv = SolanaEnv
export type PaymentConfig = { network: PaymentNetwork; rpcUrl: string }

type GenesisReader = (rpcUrl: string) => Promise<string>

/**
 * Shares one in-flight or successful verification per configured RPC. Failed
 * checks are retried on the next call. The injectable reader keeps tests off
 * the network; production uses Kit and a bounded request.
 */
export function createPaymentConfig(readGenesis: GenesisReader = genesisHash) {
  let cached: { key: string; verification: Promise<void> } | undefined
  return async (env: PaymentEnv): Promise<PaymentConfig> => {
    if (env.SOLANA_NETWORK !== 'devnet')
      throw new Error('Payments only support Solana devnet')
    const network = DEVNET
    if (!env.SOLANA_RPC_URL) throw new Error('Set SOLANA_RPC_URL')
    const rpcUrl = env.SOLANA_RPC_URL
    const key = `${network.name} ${rpcUrl}`
    if (cached?.key !== key) {
      const verification = (async () => {
        let genesis: string
        try {
          genesis = await readGenesis(rpcUrl)
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
    return { network, rpcUrl }
  }
}

async function genesisHash(rpcUrl: string) {
  return createSolanaRpc(rpcUrl)
    .getGenesisHash()
    .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
}

/** Payments verify the RPC serves devnet before allowing funds to move. */
export const paymentConfig = createPaymentConfig()
