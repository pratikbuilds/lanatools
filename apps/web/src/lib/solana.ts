import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { WalletBalances } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'
import { NETWORKS, checkNetworkEnv } from './networks'

function lookupNetwork() {
  // Vite validates dev/build configuration. Only unit tests may omit it.
  const { id } = checkNetworkEnv({
    SOLANA_NETWORK:
      import.meta.env.SOLANA_NETWORK ??
      (process.env.NODE_ENV === 'test' ? 'devnet' : undefined),
  })
  return { ...NETWORKS[id], id, usdcMint: address(NETWORKS[id].usdcMint) }
}

export const NETWORK = lookupNetwork()

export const SOL_DECIMALS = 9
export const USDC_DECIMALS = 6

/**
 * Reads native SOL and USDC balances, in base units, through the API. The
 * API reports its network; balances from another network are never shown
 * under this page's label.
 */
export async function getWalletBalances(
  getAccessToken: GetAccessToken,
  owner: Address,
) {
  const response = await fetch(
    `/api/wallet/balances?owner=${encodeURIComponent(owner)}`,
    { headers: await authorized(getAccessToken) },
  )
  if (!response.ok) throw new Error('Could not read the wallet balance.')
  const balances = WalletBalances.assert(await response.json())
  if (balances.network !== NETWORK.id)
    throw new Error(
      `The server reads Solana ${balances.network}, but this page shows ${NETWORK.label}.`,
    )
  return {
    sol: BigInt(balances.sol),
    usdc: BigInt(balances.usdc),
    tokens: balances.tokens,
  }
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

/** Lamports as SOL for display: up to four decimals, with dust shown as such. */
export function formatSol(lamports: bigint) {
  const text = formatUnits(lamports, SOL_DECIMALS, { maxFraction: 4 })
  return text === '0' && lamports > 0n ? '<0.0001' : text
}
