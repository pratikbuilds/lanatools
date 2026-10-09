/**
 * Checks the local setup while keeping Cloudflare data and Privy users
 * separate from production. Solana itself may be devnet or mainnet.
 */
import {
  parseSolanaNetwork,
  readSolanaNetwork,
} from '../packages/contracts/src/networks'
import type { NetworkId } from '../packages/contracts/src/networks'

/** Every secret the local Workers need, read from the root `.env`. */
export const REQUIRED = [
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_PAYMENT_SIGNER_ID',
  'PRIVY_PAYMENT_SIGNER_KEY',
  'SOLANA_RPC_URL',
] as const

// The production web build ships this public ID. A local app on the same
// Privy app would create real users' wallets and signer policies.
export const PRODUCTION_PRIVY_APP_ID = 'cmtu5w0xo00xn0ckyrqhcsgoc'

/** Lists what is wrong with the local secrets; empty when they are usable. */
export function checkLocalEnv(env: Record<string, string | undefined>) {
  const problems: Array<string> = []
  try {
    readSolanaNetwork(env)
  } catch {
    problems.push('Set SOLANA_NETWORK to devnet or mainnet in .env')
  }
  const missing = REQUIRED.filter((name) => !env[name])
  if (missing.length)
    problems.push(`Set ${missing.join(', ')} in .env (see .env.example)`)
  if (env.PRIVY_APP_ID === PRODUCTION_PRIVY_APP_ID)
    problems.push(
      'PRIVY_APP_ID is the production Privy app; use a separate app for local development',
    )
  if (env.SOLANA_RPC_URL?.includes('api.devnet.solana.com'))
    problems.push(
      "SOLANA_RPC_URL is Solana's public devnet RPC, which refuses Workers; use a provider's devnet URL",
    )
  return problems
}

/**
 * Local bindings stay on this machine. The root .env overrides a valid
 * checked-in network value when starting the services.
 */
export function checkLocalConfig(path: string, text: string) {
  const problems: Array<string> = []
  if (/"remote"\s*:/.test(text))
    problems.push(
      `${path} has a remote binding; local bindings must stay local`,
    )
  if (/"SOLANA_NETWORK"/.test(text)) {
    try {
      parseSolanaNetwork(/"SOLANA_NETWORK"\s*:\s*"([^"]*)"/.exec(text)?.[1])
    } catch {
      problems.push(`${path} must set SOLANA_NETWORK to devnet or mainnet`)
    }
  }
  return problems
}

/** Preserve existing devnet data and keep mainnet OAuth/transaction state apart. */
export function localStateDirectory(network: NetworkId) {
  return network === 'devnet' ? 'state' : 'state-mainnet'
}

export function requireDevnetFunding(env: Record<string, string | undefined>) {
  if (readSolanaNetwork(env) !== 'devnet')
    throw new Error(
      'dev:fund only supports SOLANA_NETWORK=devnet; mainnet funding is disabled',
    )
}

/** Parses a USDC amount such as `0.5` into base units (6 decimals). */
export function parseUsdc(amount: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount)
  if (!match) throw new Error(`Invalid USDC amount ${JSON.stringify(amount)}`)
  const units =
    BigInt(match[1] ?? '0') * 1_000_000n +
    BigInt((match[2] ?? '').padEnd(6, '0'))
  if (units === 0n) throw new Error('The USDC amount must be more than zero')
  return units
}
