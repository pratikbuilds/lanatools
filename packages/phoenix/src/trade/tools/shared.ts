import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { AllMarketStats, Orderbook } from '../../schemas'
import { MarketSymbol, forMarket } from '../../tool'
import { fetchAccount } from '../chain'
import { bookTicks } from '../price'
import type { MarketUnits, Side } from '../price'
import {
  MAX_SUBACCOUNTS,
  PHOENIX_PROGRAM,
  activationOf,
  traderAccountAddress,
} from '../rise'
import { OrderMarket, TraderBook } from '../schemas'
import type { PerpTrade } from '@lanatools/contracts'
import type { TradeContext } from '../tool'

/** Inputs and reads several trade tools share. */

export const OrderSide = z
  .enum(['buy', 'sell'])
  .describe('buy (long) or sell (short)')

export const Size = z
  .string()
  .trim()
  .describe(
    'Size in tokens as a decimal string, e.g. "0.1" SOL; it must be a whole number of lots (phoenix_get_market)',
  )

export const Price = z
  .string()
  .trim()
  .describe('USD price as a decimal string, e.g. "115.5"')

export const SlippageBps = z
  .number()
  .int()
  .min(0)
  .max(9999)
  .describe(
    'Worst price as basis points beyond the best price on the other side of the book (50 = 0.5%)',
  )

export const Subaccount = z
  .number()
  .int()
  .min(0)
  .max(MAX_SUBACCOUNTS)
  .describe(
    'Subaccount from phoenix_get_account: 0 is cross margin, the others isolated',
  )

/** Which position a tool acts on, when its market is open in more than one. */
export const PositionSubaccount = Subaccount.optional().describe(
  'Subaccount holding the position, from phoenix_get_account: 0 is cross margin, the others isolated. Needed only when the market is open in more than one',
)

/** The wallet's trader account; throws `not_activated` unless it can trade. */
export async function requireActivated(
  { rpc }: Pick<TradeContext, 'rpc'>,
  wallet: Address,
) {
  const trader = await fetchAccount(rpc, await traderAccountAddress(wallet))
  if (
    trader?.owner !== PHOENIX_PROGRAM ||
    activationOf(trader.data) !== 'activated'
  )
    throw new PhoenixError(
      'not_activated',
      'This wallet has no activated Phoenix account; call phoenix_activate_account first',
    )
  return trader
}

/** A market's order config: accounts, tick size, lot decimals. */
export function marketConfig({ phoenix }: TradeContext, symbol: string) {
  return forMarket(symbol, () =>
    phoenix.get(
      `/v1/view/exchange/market/${encodeURIComponent(symbol)}`,
      OrderMarket,
    ),
  )
}

/** Refuses a market this order cannot trade. */
function requireTradable(
  market: OrderMarket,
  marginMode: 'cross' | 'isolated',
) {
  if (market.marketStatus !== 'active')
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix's ${market.symbol} market is ${market.marketStatus}, not open for orders`,
    )
  if (market.isolatedOnly && marginMode === 'cross')
    throw new PhoenixError(
      'market_unavailable',
      `${market.symbol} trades only in isolated margin; set marginMode to isolated and give collateral`,
    )
}

/** A market's order config; refuses markets this order cannot trade. */
export async function tradableMarket(
  context: TradeContext,
  symbol: string,
  marginMode: 'cross' | 'isolated' = 'cross',
) {
  const market = await marketConfig(context, symbol)
  requireTradable(market, marginMode)
  return market
}

/** A market's tick grid. */
export const unitsOf = (market: OrderMarket): MarketUnits => ({
  tickSize: market.tickSize,
  baseLotsDecimals: market.baseLotsDecimals,
})

/**
 * The best price, in ticks, on the side an order of `side` would take from:
 * the lowest ask for a buy, the highest bid for a sell. Null when that side
 * of the book is empty.
 */
export async function bestTicks(
  { phoenix }: TradeContext,
  market: OrderMarket,
  side: Side,
) {
  const book = await forMarket(market.symbol, () =>
    phoenix.get(
      `/v1/view/orderbook/${encodeURIComponent(market.symbol)}`,
      Orderbook,
    ),
  )
  const levels = (side === 'buy' ? book.asks : book.bids).map(([price]) =>
    bookTicks(price, unitsOf(market)),
  )
  if (levels.length === 0) return null
  return levels.reduce((best, level) =>
    side === 'buy'
      ? level < best
        ? level
        : best
      : level > best
        ? level
        : best,
  )
}

/** A market's mark price, in ticks: what TP/SL triggers are checked against. */
export async function markTicks(
  { phoenix }: TradeContext,
  market: OrderMarket,
) {
  const stats = await phoenix.get('/v1/markets/stats/latest', AllMarketStats)
  const mark = stats.markets.find(
    (each) => each.symbol === market.symbol,
  )?.mark_price
  if (mark === undefined)
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix sent no mark price for ${market.symbol}`,
    )
  return bookTicks(mark, unitsOf(market))
}

/**
 * How a result names the subaccount it acts in: an isolated one by number,
 * cross by nothing, so every tool reads the same in reviews and ledgers.
 */
export function marginOf(subaccount: number) {
  return subaccount === 0
    ? { details: {}, terms: {} }
    : {
        details: { marginMode: 'isolated', subaccount: String(subaccount) },
        terms: { marginMode: 'isolated' as const },
      }
}

/** How Rise's order routes name the subaccount a request acts in. */
export const subaccountRequest = (subaccount: number) => ({
  isIsolated: subaccount !== 0,
  traderSubaccountIndex: subaccount,
})

/**
 * How a summary names an order on a perps market: a sell that is not
 * reduce-only opens or adds to a short, which "sell" alone does not say.
 */
export function orderVerb(side: Side, reduceOnly: boolean) {
  if (reduceOnly)
    return side === 'buy'
      ? 'buy to reduce a short position'
      : 'sell to reduce a long position'
  return side === 'buy' ? 'buy (long)' : 'sell (short)'
}

/** A prepared action's terms as data, for ledgers. */
export function perpTrade(
  action: PerpTrade['action'],
  terms: Omit<PerpTrade, 'kind' | 'venue' | 'action'> = {},
): PerpTrade {
  return { kind: 'perp', venue: 'phoenix', action, ...terms }
}

/** USD to the cent, for notional. */
export const usd = (value: number) => value.toFixed(2)

/** USD to six places, for fees too small to show in cents. */
export const fineUsd = (value: number) => Number(value.toFixed(6)).toString()

type TraderSubaccount = TraderBook['snapshot']['subaccounts'][number]

/** A subaccount's resting orders, in one market or all of them. */
export const restingIn = (
  account: TraderSubaccount | undefined,
  symbol?: string,
) =>
  (account?.orders ?? [])
    .filter((market) => symbol === undefined || market.symbol === symbol)
    .flatMap((market) => market.orders)
    .filter((order) => order.change !== 'closed')

/** Whether a subaccount holds an open position, in one market or any. */
export const holdsPosition = (account: TraderSubaccount, symbol?: string) =>
  account.positions.some(
    (position) =>
      (symbol === undefined || position.symbol === symbol) &&
      BigInt(position.basePositionLots) !== 0n,
  )

const traderStatePath = (wallet: Address) =>
  `/v1/trader/state/${encodeURIComponent(wallet)}`

function missingAccount(error: unknown): never {
  if (error instanceof PhoenixError && error.code === 'not_found')
    throw new PhoenixError(
      'not_activated',
      'This wallet has no Phoenix account; call phoenix_activate_account first',
    )
  throw error
}

/**
 * The collateral in the wallet's cross-margin account (subaccount 0): USDC
 * in base units, and its SOL row, in lamports.
 */
export function crossCollateralIn({ snapshot }: TraderBook) {
  const cross = snapshot.subaccounts.find(
    (subaccount) => subaccount.subaccountIndex === 0,
  )
  return {
    usdc: BigInt(cross?.collateral ?? 0),
    sol: cross?.spotCollaterals.find((row) => row.symbol === 'SOL'),
  }
}

export const crossCollateral = async (context: TradeContext, wallet: Address) =>
  crossCollateralIn(await traderBook(context, wallet))

export async function traderBook(
  { phoenix }: Pick<TradeContext, 'phoenix'>,
  wallet: Address,
) {
  return phoenix.get(traderStatePath(wallet), TraderBook).catch(missingAccount)
}

/**
 * The wallet's open position in one market: the subaccount that holds it,
 * its direction and unsigned size in lots, and the trader book it was read
 * from. A market can hold a cross and an isolated position at once, so
 * without a `subaccount` an ambiguous request is refused rather than guessed.
 */
export async function openPosition(
  context: TradeContext,
  wallet: Address,
  symbol: string,
  subaccount?: number,
) {
  const book = await traderBook(context, wallet)
  const { snapshot } = book
  const held = snapshot.subaccounts.flatMap((account) =>
    account.positions
      .filter(
        (position) =>
          position.symbol === symbol &&
          BigInt(position.basePositionLots) !== 0n,
      )
      .map((position) => ({
        subaccount: account.subaccountIndex,
        lots: BigInt(position.basePositionLots),
      })),
  )
  const matches =
    subaccount === undefined
      ? held
      : held.filter((position) => position.subaccount === subaccount)
  const [position, second] = matches
  if (!position)
    throw new PhoenixError(
      'not_found',
      `This account has no open ${symbol} position`,
    )
  if (second)
    throw new PhoenixError(
      'invalid_input',
      `${symbol} is open in subaccounts ${matches.map((each) => each.subaccount).join(' and ')}; pass subaccount from phoenix_get_account`,
    )
  const long = position.lots > 0n
  return {
    ...position,
    direction: long ? ('long' as const) : ('short' as const),
    /** The position's size in lots, without its sign. */
    held: long ? position.lots : -position.lots,
    book,
  }
}

/**
 * The subaccount whose resting orders in one market a cancel acts on. Cross
 * and isolated can both hold orders in a market, so without a `subaccount` an
 * ambiguous request is refused rather than guessed.
 */
export async function ordersAccount(
  context: TradeContext,
  wallet: Address,
  symbol: string,
  subaccount?: number,
) {
  const { snapshot } = await traderBook(context, wallet)
  const matches = snapshot.subaccounts.filter(
    (account) =>
      restingIn(account, symbol).length > 0 &&
      (subaccount === undefined || account.subaccountIndex === subaccount),
  )
  const [account, second] = matches
  if (!account)
    throw new PhoenixError(
      'not_found',
      `This account has no resting ${symbol} orders`,
    )
  if (second)
    throw new PhoenixError(
      'invalid_input',
      `${symbol} has resting orders in subaccounts ${matches.map((each) => each.subaccountIndex).join(' and ')}; pass subaccount from phoenix_get_account`,
    )
  return {
    subaccount: account.subaccountIndex,
    orders: restingIn(account, symbol),
    /** Whether the subaccount holds nothing once `cancelled` orders are gone. */
    emptiedBy: (cancelled: readonly { orderSequenceNumber: string }[]) =>
      !holdsPosition(account) &&
      restingIn(account).every((order) =>
        cancelled.some(
          (each) => each.orderSequenceNumber === order.orderSequenceNumber,
        ),
      ),
  }
}

export { MarketSymbol }
