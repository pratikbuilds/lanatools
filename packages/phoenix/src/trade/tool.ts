import type { Address, Instruction } from '@solana/kit'
import type { z } from 'zod'
import { PhoenixError, createPhoenixClient } from '../client'
import type { PhoenixClient, PhoenixErrorCode, PhoenixOpts } from '../client'
import { checkInstructions } from './checks'
import { buildTransaction } from './transaction'
import type { BuiltTransaction, FeeSettings, TradeRpc } from './transaction'

/**
 * A trade tool turns an agent's input into checked Phoenix instructions.
 * `runTradeTool` adds the shared steps: validate, check, build and simulate.
 * The result is an unsigned transaction; no tool signs or sends.
 */

export type TradeContext = {
  phoenix: PhoenixClient
  rpc: TradeRpc
}

export type PreparedInstructions = {
  /** The wallet that signs and pays. */
  wallet: Address
  instructions: Instruction[]
  /** One line for a person, e.g. "Buy 0.10 SOL at up to $117.30 (market, IOC)". */
  summary: string
  details: Record<string, string>
  warnings: string[]
}

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
  ) => Promise<PreparedInstructions>
}

export function defineTradeTool<TSchema extends z.ZodObject>(
  tool: TradeTool<TSchema>,
) {
  return tool
}

/** Where the signed transaction goes. Activation adds Phoenix's route later. */
export type Submit = { via: 'rpc' }

export type PreparedTransaction = Omit<PreparedInstructions, 'instructions'> &
  BuiltTransaction & { submit: Submit }

export type TradeOpts = PhoenixOpts & { rpc: TradeRpc; fees: FeeSettings }

export type TradeOutcome =
  | { ok: true; result: PreparedTransaction }
  | {
      ok: false
      error: { code: PhoenixErrorCode; message: string; retryable: boolean }
    }

/**
 * Validates `input`, prepares the tool's instructions, checks them, and
 * builds and simulates the unsigned transaction. Never throws: failures come
 * back as a safe error, without raw upstream bodies.
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
    const { instructions, ...prepared } = await tool.prepare(
      { phoenix: createPhoenixClient(opts), rpc: opts.rpc },
      parsed.data,
    )
    checkInstructions(instructions, {
      wallet: prepared.wallet,
      ...(tool.programs ? { programs: tool.programs } : {}),
    })
    const built = await buildTransaction(opts.rpc, {
      feePayer: prepared.wallet,
      instructions,
      fees: opts.fees,
    })
    return {
      ok: true,
      result: { ...prepared, ...built, submit: { via: 'rpc' } },
    }
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
