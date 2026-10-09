import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isAddress } from '@solana/kit'

/**
 * Arguments for scripts/trade.ts. Each command maps to one Phoenix trade
 * tool and its input, without the wallet: the script adds it from the
 * keypair (or `--as`, for a simulation only).
 */

export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export const USAGE = `Usage: bun packages/phoenix/scripts/trade.ts <command> [args] --rpc <mainnet RPC URL>

Commands:
  activate [--code CODE]
  state
  deposit <usdc>
  withdraw <usdc>
  market <symbol> <buy|sell> <size> (--slippage-bps N | --limit-price P) [--reduce-only]
  limit <symbol> <buy|sell> <size> <price> [--post-only] [--reduce-only]
  cancel <symbol> [--id ID ...]
  close <symbol> [--fraction F] (--slippage-bps N | --limit-price P)

Options:
  --rpc URL        Solana mainnet RPC (required)
  --keypair PATH   Signing keypair (default ~/.config/solana/id.json)
  --dry-run        Prepare and simulate only; never sign or send
  --as ADDRESS     With --dry-run: simulate as another wallet`

export type Command =
  | { command: 'state' }
  | { command: 'tool'; tool: string; input: Record<string, unknown> }

export type CliArgs = Command & {
  rpc: string
  keypair: string
  dryRun: boolean
  as: string | null
}

function need(value: string | undefined, what: string) {
  if (value === undefined || value === '')
    throw new UsageError(`Missing ${what}`)
  return value
}

function side(value: string | undefined) {
  const given = need(value, 'side (buy or sell)')
  if (given !== 'buy' && given !== 'sell')
    throw new UsageError(`Side must be buy or sell, not ${given}`)
  return given
}

function integer(value: string, what: string) {
  if (!/^\d+$/.test(value))
    throw new UsageError(`${what} must be a whole number`)
  return Number(value)
}

function decimal(value: string, what: string) {
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new UsageError(`${what} must be a number such as 0.5`)
  return Number(value)
}

/** The worst price of a market or close order: exactly one, no default (D1). */
function worstPrice(slippage: string | undefined, limit: string | undefined) {
  if ((slippage === undefined) === (limit === undefined))
    throw new UsageError('Give exactly one of --slippage-bps or --limit-price')
  return slippage === undefined
    ? { limitPrice: limit }
    : { maxSlippageBps: integer(slippage, '--slippage-bps') }
}

export function parseCli(argv: readonly string[]): CliArgs {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        rpc: { type: 'string' },
        keypair: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        as: { type: 'string' },
        code: { type: 'string' },
        'slippage-bps': { type: 'string' },
        'limit-price': { type: 'string' },
        'reduce-only': { type: 'boolean', default: false },
        'post-only': { type: 'boolean', default: false },
        id: { type: 'string', multiple: true },
        fraction: { type: 'string' },
      },
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  const [name, ...rest] = positionals
  const arg = (index: number, what: string) => need(rest[index], what)
  const reduceOnly = values['reduce-only']

  let command: Command
  switch (name) {
    case 'state':
      command = { command: 'state' }
      break
    case 'activate':
      command = {
        command: 'tool',
        tool: 'phoenix_activate_account',
        input: values.code ? { referralCode: values.code } : {},
      }
      break
    case 'deposit':
    case 'withdraw':
      command = {
        command: 'tool',
        tool: `phoenix_${name}`,
        input: { amount: arg(0, 'USDC amount') },
      }
      break
    case 'market':
      command = {
        command: 'tool',
        tool: 'phoenix_market_order',
        input: {
          symbol: arg(0, 'market symbol'),
          side: side(rest[1]),
          size: arg(2, 'size in tokens'),
          ...worstPrice(values['slippage-bps'], values['limit-price']),
          reduceOnly,
        },
      }
      break
    case 'limit':
      command = {
        command: 'tool',
        tool: 'phoenix_limit_order',
        input: {
          symbol: arg(0, 'market symbol'),
          side: side(rest[1]),
          size: arg(2, 'size in tokens'),
          price: arg(3, 'price in USD'),
          postOnly: values['post-only'],
          reduceOnly,
        },
      }
      break
    case 'cancel':
      command = {
        command: 'tool',
        tool: 'phoenix_cancel_orders',
        input: {
          symbol: arg(0, 'market symbol'),
          ...(values.id ? { orderIds: values.id } : {}),
        },
      }
      break
    case 'close':
      command = {
        command: 'tool',
        tool: 'phoenix_close_position',
        input: {
          symbol: arg(0, 'market symbol'),
          ...(values.fraction === undefined
            ? {}
            : { fraction: decimal(values.fraction, '--fraction') }),
          ...worstPrice(values['slippage-bps'], values['limit-price']),
        },
      }
      break
    default:
      throw new UsageError(name ? `Unknown command ${name}` : 'Missing command')
  }

  const as = values.as ?? null
  if (as !== null && !isAddress(as))
    throw new UsageError(`--as must be a Solana address, not ${as}`)
  if (as !== null && !values['dry-run'])
    throw new UsageError(
      '--as only simulates; it needs --dry-run, and nothing is signed for that wallet',
    )
  return {
    ...command,
    rpc: need(values.rpc, '--rpc (a Solana mainnet RPC URL)'),
    keypair: values.keypair ?? join(homedir(), '.config/solana/id.json'),
    dryRun: values['dry-run'],
    as,
  }
}
