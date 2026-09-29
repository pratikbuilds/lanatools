/**
 * Everything that differs between testbed networks. Scripts pick a profile
 * once with `--network` and never branch on the network themselves.
 */
import { join } from 'node:path'
import type { Address } from '@solana/kit'
import { assertSurfpool, setTokenBalance } from './rpc'

export const MERCHANT_ORIGIN = 'http://127.0.0.1:1402'
const STATE = join(import.meta.dir, '..', '.state')

export type Profile = {
  name: 'sandbox' | 'devnet'
  /** The network pay challenges name and Pay Kit permissions allow. */
  network: 'localnet' | 'devnet'
  rpcUrl: string
  usdcMint: string
  /** pay's private HOME and gateway log. */
  stateDir: string
  /** Sandbox wallets are disposable; devnet keeps its funded fee payer. */
  resetState: boolean
  /** Flags placed before pay's subcommand. */
  payFlags: Array<string>
  /** Extra `pay gate api` flags. */
  gateFlags: () => Array<string>
  /** Fails unless the RPC can serve this profile. */
  preflight: () => Promise<void>
  /** Gives the owner USDC in base units. */
  fund: (owner: Address, amount: bigint) => Promise<void>
  /** Gives pay's new gateway fee payer SOL, if this network needs it. */
  fundFeePayer?: (feePayer: string) => void
}

// The hosted Surfpool behind `pay --sandbox`. It forks mainnet, so challenges
// name the mainnet USDC mint and cheatcodes fund wallets for free.
const SANDBOX_RPC_URL = 'https://402.surfnet.dev:8899'
const sandbox: Profile = {
  name: 'sandbox',
  network: 'localnet',
  rpcUrl: SANDBOX_RPC_URL,
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  stateDir: join(STATE, 'sandbox'),
  resetState: true,
  payFlags: ['--sandbox'],
  gateFlags: () => [],
  preflight: () => assertSurfpool(SANDBOX_RPC_URL),
  fund: async (owner, amount) => {
    await setTokenBalance(SANDBOX_RPC_URL, owner, sandbox.usdcMint, amount)
  },
}

// Devnet has no cheatcodes, and its public faucet is rate-limited. The default
// Solana CLI keypair pays for everything and receives merchant payments.
const DEVNET_RPC_URL =
  process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
const devnet: Profile = {
  name: 'devnet',
  network: 'devnet',
  rpcUrl: DEVNET_RPC_URL,
  // Circle's devnet USDC, the mint Pay Kit resolves for `devnet` challenges.
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  stateDir: join(STATE, 'devnet'),
  resetState: false,
  // pay has no devnet flag; the gateway takes its network from the spec.
  payFlags: [],
  gateFlags: () => [
    '--rpc-url',
    DEVNET_RPC_URL,
    '--recipient',
    solanaCli('solana', ['address']),
  ],
  preflight: async () => {
    solanaCli('solana', ['address'])
  },
  fund: async (owner, amount) => {
    solanaCli('spl-token', [
      'transfer',
      devnet.usdcMint,
      // spl-token takes UI units; USDC has 6 decimals.
      (Number(amount) / 1e6).toFixed(6),
      owner,
      '--fund-recipient',
      '--allow-unfunded-recipient',
    ])
  },
  fundFeePayer: (feePayer) => {
    console.log(`funding gateway fee payer ${feePayer} with 0.1 devnet SOL`)
    solanaCli('solana', [
      'transfer',
      feePayer,
      '0.1',
      '--allow-unfunded-recipient',
    ])
  },
}

/** Runs a Solana CLI command with the default keypair, pinned to devnet. */
function solanaCli(command: 'solana' | 'spl-token', argv: Array<string>) {
  const run = Bun.spawnSync([command, ...argv, '--url', DEVNET_RPC_URL])
  if (!run.success)
    throw new Error(
      `${command} ${argv[0]} failed; is the Solana CLI wallet funded on devnet? ${run.stderr}`,
    )
  return run.stdout.toString().trim()
}

export const profiles = { sandbox, devnet }

export function selectProfile(name = 'sandbox'): Profile {
  if (name === 'sandbox' || name === 'devnet') return profiles[name]
  throw new Error(
    `Unknown network ${JSON.stringify(name)}; use sandbox or devnet`,
  )
}
