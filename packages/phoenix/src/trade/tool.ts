import type {
  Address,
  Base64EncodedWireTransaction,
  Instruction,
} from '@solana/kit'
import type { z } from 'zod'
import type { PerpTrade } from '@lanatools/contracts'
import { Wallet } from '../tool'
import { PhoenixError, createPhoenixClient } from '../client'
import type { PhoenixClient, PhoenixErrorCode, PhoenixOpts } from '../client'
import { checkInstructions } from './checks'
import { buildTransaction, messageOf, simulateTransaction } from './transaction'
import type {
  BuiltTransaction,
  FeeSettings,
  Simulation,
  TradeRpc,
} from './transaction'

/**
 * A trade tool turns an agent's input into checked Phoenix instructions.
 * `runTradeTool` adds the shared steps: validate, check, build and simulate.
 * The result is an unsigned transaction; no tool signs or sends.
 */

export type TradeContext = {
  phoenix: PhoenixClient
  rpc: TradeRpc
}

/** Where a signed transaction goes. The tool decides, never the caller. */
export type Submit =
  | { via: 'rpc' }
  | {
      /**
       * Phoenix co-signs and submits referral activation. The wallet also
       * signs `login.message` (UTF-8, ed25519, base58) to log in to
       * Phoenix's API; that signature moves no funds.
       */
      via: 'phoenix-referral'
      referralCode: string
      recentBlockhash: string
      login: { message: string; nonceId: string }
    }

/** The market whose position an order changes, to report what filled. */
export type PositionRef = {
  symbol: string
  assetId: number
  baseLotsDecimals: number
}

type Described = {
  /** The wallet that signs and pays. */
  wallet: Address
  /** One line for a person, e.g. "Buy 0.10 SOL at up to $117.30 (market, IOC)". */
  summary: string
  details: Record<string, string>
  /** The same terms as data, for ledgers that show the trade. */
  trade: PerpTrade
  warnings: string[]
  /**
   * Market and close orders: Phoenix ignores the order after this slot (and
   * still reports success), so it is never sent later.
   */
  expiresAfterSlot?: string
  /** Market and close orders: the position the order changes. */
  position?: PositionRef
}

/** What a tool's `prepare` returns. */
export type Prepared =
  /** Instructions the shared builder turns into a transaction. */
  | (Described & { kind: 'instructions'; instructions: Instruction[] })
  /** A whole transaction built elsewhere, checked and simulated as is. */
  | (Described & {
      kind: 'transaction'
      transaction: Base64EncodedWireTransaction
      lastValidBlockHeight: string
      /** Signers besides the wallet, who sign on their own side. */
      coSigners: readonly Address[]
      submit: Submit
    })
  /** Nothing needs signing, e.g. the account is already active. */
  | { kind: 'nothing_to_do'; wallet: Address; summary: string }

export type TradeTool<TSchema extends z.ZodObject = z.ZodObject> = {
  name: string
  title: string
  description: string
  input: TSchema
  /** Programs this tool may call, when not the default trade programs. */
  programs?: readonly Address[]
  prepare: (
    context: TradeContext,
    input: z.output<TSchema>,
  ) => Promise<Prepared>
}

export function defineTradeTool<TShape extends z.ZodRawShape>(tool: {
  name: string
  title: string
  description: string
  arguments: z.ZodObject<TShape>
  programs?: readonly Address[]
  prepare: (
    context: TradeContext,
    input: z.output<z.ZodObject<TShape>> & { wallet: string },
  ) => Promise<Prepared>
}) {
  return {
    ...tool,
    input: tool.arguments.safeExtend({ wallet: Wallet } as Parameters<
      typeof tool.arguments.safeExtend<{ wallet: typeof Wallet }>
    >[0]),
  }
}

export type PreparedTransaction = Described &
  BuiltTransaction & { status: 'ready'; submit: Submit }

export type NothingToDo = {
  status: 'nothing_to_do'
  wallet: Address
  summary: string
}

/**
 * The transaction would fail as built, so there is nothing to sign; the
 * simulation says why. Preparing it again may succeed once the cause (the
 * book, the balance, a stale blockhash) changes.
 */
export type SimulationFailed = Described & {
  status: 'simulation_failed'
  simulation: Simulation
}

export type TradeOpts = PhoenixOpts & { rpc: TradeRpc; fees: FeeSettings }

export type TradeOutcome =
  | { ok: true; result: PreparedTransaction | SimulationFailed | NothingToDo }
  | {
      ok: false
      error: { code: PhoenixErrorCode; message: string; retryable: boolean }
    }

async function finish(
  tool: TradeTool,
  prepared: Exclude<Prepared, { kind: 'nothing_to_do' }>,
  opts: TradeOpts,
): Promise<PreparedTransaction> {
  if (prepared.kind === 'instructions') {
    const { kind: _kind, instructions, ...described } = prepared
    checkInstructions(instructions, {
      wallet: described.wallet,
      ...(tool.programs ? { programs: tool.programs } : {}),
    })
    const built = await buildTransaction(opts.rpc, {
      feePayer: described.wallet,
      instructions,
      fees: opts.fees,
    })
    return { ...described, ...built, status: 'ready', submit: { via: 'rpc' } }
  }

  const {
    kind: _kind,
    transaction,
    lastValidBlockHeight,
    coSigners,
    submit,
    ...described
  } = prepared
  const message = messageOf(transaction)
  if (message.feePayer !== described.wallet)
    throw new PhoenixError(
      'check_failed',
      'The built Phoenix transaction failed a safety check (the wallet does not pay); nothing was signed',
    )
  checkInstructions(message.instructions, {
    wallet: described.wallet,
    coSigners,
    ...(tool.programs ? { programs: tool.programs } : {}),
  })
  const simulation: Simulation = await simulateTransaction(
    opts.rpc,
    message.wire,
  )
  return {
    ...described,
    transaction: message.wire,
    lastValidBlockHeight,
    simulation,
    status: 'ready',
    submit,
  }
}

/**
 * Validates `input`, prepares the tool's transaction, checks it, and
 * simulates it unsigned. Never throws: failures come back as a safe error,
 * without raw upstream bodies.
 */
export async function runTradeTool<TSchema extends z.ZodObject>(
  tool: TradeTool<TSchema>,
  input: unknown,
  opts: TradeOpts,
): Promise<TradeOutcome> {
  try {
    const parsed = tool.input.safeParse(input ?? {})
    if (!parsed.success)
      throw new PhoenixError(
        'invalid_input',
        parsed.error.issues.map((issue) => issue.message).join('; '),
      )
    const prepared = await tool.prepare(
      { phoenix: createPhoenixClient(opts), rpc: opts.rpc },
      parsed.data,
    )
    if (prepared.kind === 'nothing_to_do')
      return {
        ok: true,
        result: {
          status: 'nothing_to_do',
          wallet: prepared.wallet,
          summary: prepared.summary,
        },
      }
    const result = await finish(tool, prepared, opts)
    if (!result.simulation.ok) {
      const {
        status: _status,
        transaction: _transaction,
        lastValidBlockHeight: _lastValidBlockHeight,
        submit: _submit,
        ...failed
      } = result
      return { ok: true, result: { ...failed, status: 'simulation_failed' } }
    }
    return { ok: true, result }
  } catch (error) {
    if (error instanceof PhoenixError)
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        },
      }
    console.error(
      JSON.stringify({
        message: 'Phoenix trade tool failed',
        tool: tool.name,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return {
      ok: false,
      error: {
        code: 'upstream_error',
        message: 'Could not prepare the Phoenix transaction',
        retryable: false,
      },
    }
  }
}
