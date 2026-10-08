/**
 * Phoenix trade tools: unsigned transactions for the Phoenix perps program.
 * A separate entry point (`@lanatools/phoenix/trade`) so that importing the
 * read tools never loads the Rise SDK.
 */
import { activateAccount } from './tools/activate'
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
  withdraw,
] as const

export { LANATOOLS_REFERRAL_CODE } from './tools/activate'
export { defineTradeTool, runTradeTool } from './tool'
export type {
  NothingToDo,
  Prepared,
  PreparedTransaction,
  Submit,
  TradeContext,
  TradeOpts,
  TradeOutcome,
  TradeTool,
} from './tool'
export { submitSignedTransaction } from './submit'
export type { SignedTrade, SubmitOpts } from './submit'
export { MAX_COMPUTE_UNITS } from './transaction'
export type {
  FeeSettings,
  SendResult,
  Simulation,
  TradeRpc,
} from './transaction'
