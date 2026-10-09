import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { Orderbook } from '../../schemas'
import { MarketSymbol, forMarket } from '../../tool'
import { fetchAccount } from '../chain'
import { bookTicks } from '../price'
import type { MarketUnits, Side } from '../price'
import { PHOENIX_PROGRAM, activationOf, traderAccountAddress } from '../rise'
import { OrderMarket, TraderBook } from '../schemas'
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

/** Throws `not_activated` unless the wallet's trader account can trade. */
export async function requireActivated({ rpc }: TradeContext, wallet: Address) {
  const trader = await fetchAccount(rpc, await traderAccountAddress(wallet))
  if (
    trader?.owner !== PHOENIX_PROGRAM ||
    activationOf(trader.data) !== 'activated'
  )
    throw new PhoenixError(
      'not_activated',
      'This wallet has no activated Phoenix account; call phoenix_activate_account first',
    )
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

/** A market's order config; refuses markets these tools cannot trade. */
export async function tradableMarket(context: TradeContext, symbol: string) {
  const market = await marketConfig(context, symbol)
  if (market.marketStatus !== 'active')
    throw new PhoenixError(
      'market_unavailable',
      `Phoenix's ${market.symbol} market is ${market.marketStatus}, not open for orders`,
    )
  if (market.isolatedOnly)
    throw new PhoenixError(
      'market_unavailable',
      `${market.symbol} trades only in isolated margin, which these tools do not support yet`,
    )
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

/** USD to the cent, for notional. */
export const usd = (value: number) => value.toFixed(2)

/** USD to six places, for fees too small to show in cents. */
export const fineUsd = (value: number) => Number(value.toFixed(6)).toString()

/**
 * The wallet's cross-margin account (subaccount 0) as Phoenix's API sees
 * it: positions and resting orders. These tools trade nothing else.
 */
export async function crossAccount({ phoenix }: TradeContext, wallet: Address) {
  const book = await phoenix
    .get(`/v1/trader/state/${encodeURIComponent(wallet)}`, TraderBook)
    .catch((error: unknown) => {
      if (error instanceof PhoenixError && error.code === 'not_found')
        throw new PhoenixError(
          'not_activated',
          'This wallet has no Phoenix account; call phoenix_activate_account first',
        )
      throw error
    })
  const cross = book.snapshot.subaccounts.find(
    (subaccount) => subaccount.subaccountIndex === 0,
  )
  return {
    positions: cross?.positions ?? [],
    /** Resting orders still on the book in one market. */
    ordersIn: (symbol: string) =>
      (cross?.orders ?? [])
        .filter((market) => market.symbol === symbol)
        .flatMap((market) => market.orders)
        .filter((order) => order.change !== 'closed'),
  }
}

export { MarketSymbol }
