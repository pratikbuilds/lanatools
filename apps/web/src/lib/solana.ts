import { address, createSolanaRpc } from '@solana/kit'
import type { Address } from '@solana/kit'

// Each network pairs an RPC with the USDC mint that exists on it. Sending
// USDC on the wrong network loses it, so the page always names the network.
const NETWORKS = {
  sandbox: {
    label: 'Surfpool sandbox',
    rpcURL: 'https://402.surfnet.dev:8899',
    // Surfpool forks mainnet, so the sandbox holds mainnet USDC.
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    test: true,
  },
  devnet: {
    label: 'Solana devnet',
    rpcURL: 'https://api.devnet.solana.com',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    test: true,
  },
  mainnet: {
    label: 'Solana mainnet',
    rpcURL: 'https://api.mainnet-beta.solana.com',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    test: false,
  },
} as const

type NetworkId = keyof typeof NETWORKS

function isNetworkId(value: string): value is NetworkId {
  return Object.hasOwn(NETWORKS, value)
}

function lookupNetwork() {
  const id = import.meta.env.VITE_SOLANA_NETWORK ?? 'sandbox'
  if (!isNetworkId(id)) {
    throw new Error(
      `VITE_SOLANA_NETWORK must be one of ${Object.keys(NETWORKS).join(', ')}`,
    )
  }
  const network = NETWORKS[id]
  return {
    ...network,
    id,
    rpcURL: import.meta.env.VITE_SOLANA_RPC_URL ?? network.rpcURL,
    usdcMint: address(network.usdcMint),
  }
}

export const NETWORK = lookupNetwork()

const rpc = createSolanaRpc(NETWORK.rpcURL)

export const SOL_DECIMALS = 9
export const USDC_DECIMALS = 6

/** Reads native SOL and USDC balances, in base units, at confirmed commitment. */
export async function getWalletBalances(owner: Address) {
  const [sol, usdcAccounts] = await Promise.all([
    rpc.getBalance(owner, { commitment: 'confirmed' }).send(),
    rpc
      .getTokenAccountsByOwner(
        owner,
        { mint: NETWORK.usdcMint },
        { encoding: 'jsonParsed', commitment: 'confirmed' },
      )
      .send(),
  ])
  const usdc = usdcAccounts.value.reduce(
    (sum, { account }) =>
      sum + BigInt(account.data.parsed.info.tokenAmount.amount),
    0n,
  )
  return { sol: sol.value, usdc }
}

/**
 * Formats base units as a decimal string, truncated (never rounded up) to
 * `maxFraction` digits and padded to `minFraction`.
 */
export function formatUnits(
  amount: bigint,
  decimals: number,
  {
    maxFraction,
    minFraction = 0,
  }: { maxFraction: number; minFraction?: number },
) {
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const fraction = (amount % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFraction)
    .replace(/0+$/, '')
    .padEnd(minFraction, '0')
  const grouped = whole.toLocaleString('en-US')
  return fraction ? `${grouped}.${fraction}` : grouped
}
