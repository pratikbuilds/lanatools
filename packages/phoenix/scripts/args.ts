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
  deposit <amount> [--asset SOL]
  withdraw <amount> [--asset SOL]
  market <symbol> <buy|sell> <size> (--slippage-bps N | --limit-price P) [--reduce-only]
  limit <symbol> <buy|sell> <size> <price> [--post-only] [--reduce-only]
    Either order in isolated margin: --isolated [--collateral-usdc N] [--collateral-sol N]
  cancel <symbol> [--id ID ...] [--subaccount N]
  close <symbol> [--fraction F] (--slippage-bps N | --limit-price P) [--subaccount N]
  add-margin <symbol> <usdc> [--subaccount N]
  set-tpsl <symbol> [--tp P --tp-worst P] [--sl P --sl-worst P] (--percent N | --size S) [--subaccount N]
  cancel-tpsl <symbol> <takeProfit|stopLoss|both> [--slot N] [--subaccount N]

Options:
  --rpc URL        Solana mainnet RPC (required)
  --keypair PATH   Signing keypair (default ~/.config/solana/id.json)
  --dry-run        Prepare and simulate only; never sign or send
  --as ADDRESS     With --dry-run: simulate as another wallet
  --asset ASSET    With deposit or withdraw: USDC (default) or SOL`

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

/** A decimal argument as typed: amounts stay exact strings. */
function decimalText(value: string, what: string) {
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new UsageError(`${what} must be a number such as 0.5`)
  return value
}

function decimal(value: string, what: string) {
  return Number(decimalText(value, what))
}

function asset(value: string | undefined) {
  if (value === undefined) return {}
  if (value !== 'USDC' && value !== 'SOL')
    throw new UsageError(`--asset must be USDC or SOL, not ${value}`)
  return { asset: value }
}

/** A TP or SL: a trigger and its worst price come together (D5). */
function trigger(
  price: string | undefined,
  worst: string | undefined,
  flag: string,
) {
  if ((price === undefined) !== (worst === undefined))
    throw new UsageError(`Give both --${flag} and --${flag}-worst`)
  return price === undefined
    ? undefined
    : { triggerPrice: price, worstPrice: worst }
}

function leg(value: string | undefined) {
  const given = need(value, 'leg (takeProfit, stopLoss or both)')
  if (given !== 'takeProfit' && given !== 'stopLoss' && given !== 'both')
    throw new UsageError(
      `Leg must be takeProfit, stopLoss or both, not ${given}`,
    )
  return given
}

/** How much of a position a TP/SL covers: exactly one, no default. */
function coverage(percent: string | undefined, size: string | undefined) {
  if ((percent === undefined) === (size === undefined))
    throw new UsageError('Give exactly one of --percent or --size')
  return percent === undefined
    ? { size }
    : { percent: integer(percent, '--percent') }
}

const subaccount = (value: string | undefined) =>
  value === undefined ? {} : { subaccount: integer(value, '--subaccount') }

/** The worst price of a market or close order: exactly one, no default (D1). */
function worstPrice(slippage: string | undefined, limit: string | undefined) {
  if ((slippage === undefined) === (limit === undefined))
    throw new UsageError('Give exactly one of --slippage-bps or --limit-price')
  return slippage === undefined
    ? { limitPrice: limit }
    : { maxSlippageBps: integer(slippage, '--slippage-bps') }
}

/** An order's isolated margin flags; a cross order states none. */
function isolatedInput(
  isolated: boolean,
  usdc: string | undefined,
  sol: string | undefined,
) {
  if (!isolated && (usdc !== undefined || sol !== undefined))
    throw new UsageError(
      '--collateral-usdc and --collateral-sol need --isolated',
    )
  if (!isolated) return {}
  return {
    marginMode: 'isolated',
    ...(usdc === undefined
      ? {}
      : { collateralUsdc: decimalText(usdc, '--collateral-usdc') }),
    ...(sol === undefined
      ? {}
      : { collateralSol: decimalText(sol, '--collateral-sol') }),
  }
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
        isolated: { type: 'boolean', default: false },
        'collateral-usdc': { type: 'string' },
        'collateral-sol': { type: 'string' },
        subaccount: { type: 'string' },
        asset: { type: 'string' },
        tp: { type: 'string' },
        'tp-worst': { type: 'string' },
        sl: { type: 'string' },
        'sl-worst': { type: 'string' },
        percent: { type: 'string' },
        size: { type: 'string' },
        slot: { type: 'string' },
      },
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { values, positionals } = parsed
  const [name, ...rest] = positionals
  const arg = (index: number, what: string) => need(rest[index], what)
  const reduceOnly = values['reduce-only']
  const margin = () =>
    isolatedInput(
      values.isolated,
      values['collateral-usdc'],
      values['collateral-sol'],
    )

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
        input: { amount: arg(0, 'amount'), ...asset(values.asset) },
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
          ...margin(),
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
          ...margin(),
        },
      }
      break
    case 'cancel':
      command = {
        command: 'tool',
        tool: 'phoenix_cancel_orders',
        input: {
          symbol: arg(0, 'market symbol'),
          ...subaccount(values.subaccount),
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
          ...subaccount(values.subaccount),
          ...(values.fraction === undefined
            ? {}
            : { fraction: decimal(values.fraction, '--fraction') }),
          ...worstPrice(values['slippage-bps'], values['limit-price']),
        },
      }
      break
    case 'add-margin':
      command = {
        command: 'tool',
        tool: 'phoenix_add_isolated_margin',
        input: {
          symbol: arg(0, 'market symbol'),
          amount: arg(1, 'USDC amount'),
          ...subaccount(values.subaccount),
        },
      }
      break
    case 'set-tpsl': {
      const takeProfit = trigger(values.tp, values['tp-worst'], 'tp')
      const stopLoss = trigger(values.sl, values['sl-worst'], 'sl')
      if (!takeProfit && !stopLoss)
        throw new UsageError('Give --tp, --sl or both')
      command = {
        command: 'tool',
        tool: 'phoenix_set_tpsl',
        input: {
          symbol: arg(0, 'market symbol'),
          ...(takeProfit ? { takeProfit } : {}),
          ...(stopLoss ? { stopLoss } : {}),
          ...coverage(values.percent, values.size),
          ...subaccount(values.subaccount),
        },
      }
      break
    }
    case 'cancel-tpsl':
      command = {
        command: 'tool',
        tool: 'phoenix_cancel_tpsl',
        input: {
          symbol: arg(0, 'market symbol'),
          leg: leg(rest[1]),
          ...(values.slot === undefined
            ? {}
            : { slot: integer(values.slot, '--slot') }),
          ...subaccount(values.subaccount),
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
