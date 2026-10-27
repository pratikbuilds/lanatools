import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { WalletBalances } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'
import { selectedNetwork } from './networks'

export { formatSol, formatUnits } from './units'

function lookupNetwork() {
  const network = selectedNetwork()
  return { ...network, usdcMint: address(network.usdcMint) }
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
  options?: { tokens?: boolean },
) {
  const params = new URLSearchParams({ owner })
  // The wallet figure needs SOL and USDC. Other tokens are read when
  // Withdraw opens, so the home page does not wait on account scans.
  if (options?.tokens) params.set('tokens', '1')
  const response = await fetch(`/api/wallet/balances?${params}`, {
    headers: await authorized(getAccessToken),
  })
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
