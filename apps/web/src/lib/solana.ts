import { address, createSolanaRpc } from '@solana/kit'
import type { Address } from '@solana/kit'
import { NETWORKS, checkNetworkEnv, checkRpcNetwork } from './networks'

function lookupNetwork() {
  // Builds must name a network (see vite.config.ts); dev servers and tests
  // fall back to the sandbox.
  const { id, rpcURL } = checkNetworkEnv({
    VITE_SOLANA_NETWORK: import.meta.env.VITE_SOLANA_NETWORK ?? 'sandbox',
    VITE_SOLANA_RPC_URL: import.meta.env.VITE_SOLANA_RPC_URL,
  })
  return {
    ...NETWORKS[id],
    id,
    rpcURL,
    usdcMint: address(NETWORKS[id].usdcMint),
  }
}

export const NETWORK = lookupNetwork()

const rpc = createSolanaRpc(NETWORK.rpcURL)

let networkCheck: Promise<void> | undefined

/**
 * Confirms once that the RPC serves the network the page names, so an RPC
 * override for another network cannot show its balances under this label.
 */
function verifyNetwork() {
  networkCheck ??= checkRpcNetwork(NETWORK.rpcURL, NETWORK.id)
  // Let a failed check run again on the next balance read.
  networkCheck.catch(() => {
    networkCheck = undefined
  })
  return networkCheck
}

export const SOL_DECIMALS = 9
export const USDC_DECIMALS = 6

/** Reads native SOL and USDC balances, in base units, at confirmed commitment. */
export async function getWalletBalances(owner: Address) {
  await verifyNetwork()
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
