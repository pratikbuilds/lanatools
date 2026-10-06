/**
 * Checks for the local devnet setup that `bun run dev` starts. They keep
 * local development away from production users, wallets and data.
 */

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
 * Lists what is wrong with a local Wrangler config. Local bindings must stay
 * on this machine, and the API must pay on devnet.
 */
export function checkLocalConfig(path: string, text: string) {
  const problems: Array<string> = []
  if (/"remote"\s*:/.test(text))
    problems.push(
      `${path} has a remote binding; local bindings must stay local`,
    )
  if (
    /"SOLANA_NETWORK"/.test(text) &&
    !/"SOLANA_NETWORK"\s*:\s*"devnet"/.test(text)
  )
    problems.push(`${path} must set SOLANA_NETWORK to devnet`)
  return problems
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
