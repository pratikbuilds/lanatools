/**
 * Phoenix trade tools: unsigned transactions for the Phoenix perps program.
 * A separate entry point (`@lanatools/phoenix/trade`) so that importing the
 * read tools never loads the Rise SDK.
 */
import { PhoenixError } from '../client'
import type { z } from 'zod'
import { runTradeTool } from './tool'
import type { TradeOpts, TradeOutcome, TradeTool } from './tool'
import { activateAccount } from './tools/activate'
import { cancelOrders } from './tools/cancel'
import { closePosition } from './tools/close'
import { deposit } from './tools/deposit'
import { limitOrder } from './tools/limit-order'
import { marketOrder } from './tools/market-order'
import { withdraw } from './tools/withdraw'

/** Phoenix trade tools, in the order an agent usually needs them. */
export const phoenixTrade = [
  activateAccount,
  deposit,
  marketOrder,
  limitOrder,
  cancelOrders,
  closePosition,
  withdraw,
] as const

type Runner = (input: unknown, opts: TradeOpts) => Promise<TradeOutcome>

const runnerFor =
  <TSchema extends z.ZodObject>(tool: TradeTool<TSchema>): Runner =>
  (input, opts) =>
    runTradeTool(tool, input, opts)

const runners = new Map<string, Runner>([
  [activateAccount.name, runnerFor(activateAccount)],
  [deposit.name, runnerFor(deposit)],
  [marketOrder.name, runnerFor(marketOrder)],
  [limitOrder.name, runnerFor(limitOrder)],
  [cancelOrders.name, runnerFor(cancelOrders)],
  [closePosition.name, runnerFor(closePosition)],
  [withdraw.name, runnerFor(withdraw)],
])

/**
 * Runs the trade tool named `name`. Like `runTradeTool`, it never throws;
 * an unknown name is an `invalid_input` error.
 */
export function runPhoenixTrade(
  name: string,
  input: unknown,
  opts: TradeOpts,
): Promise<TradeOutcome> {
  const run = runners.get(name)
  if (run) return run(input, opts)
  const error = new PhoenixError('invalid_input', `No trade tool named ${name}`)
  return Promise.resolve({
    ok: false,
    error: { code: error.code, message: error.message, retryable: false },
  })
}

export { LANATOOLS_REFERRAL_CODE } from './tools/activate'
export { defineTradeTool, runTradeTool } from './tool'
export type {
  NothingToDo,
  Prepared,
  PositionRef,
  PreparedTransaction,
  SimulationFailed,
  Submit,
  TradeContext,
  TradeOpts,
  TradeOutcome,
  TradeTool,
} from './tool'
export { positionSize } from './chain'
export { submitSignedTransaction } from './submit'
export type { SignedTrade, SubmitOpts } from './submit'
export { MAX_COMPUTE_UNITS } from './transaction'
export type {
  FeeSettings,
  SendResult,
  Simulation,
  TradeRpc,
} from './transaction'
