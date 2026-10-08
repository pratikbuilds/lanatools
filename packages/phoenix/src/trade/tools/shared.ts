import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { Orderbook } from '../../schemas'
import { MarketSymbol, forMarket } from '../../tool'
import { fetchAccount } from '../chain'
import { decimalString } from '../price'
import type { Side } from '../price'
import { PHOENIX_PROGRAM, activationOf, traderAccountAddress } from '../rise'
import { OrderMarket } from '../schemas'
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

/** A market's order config; refuses markets these tools cannot trade. */
export async function tradableMarket(
  { phoenix }: TradeContext,
  symbol: string,
) {
  const market = await forMarket(symbol, () =>
    phoenix.get(
      `/v1/view/exchange/market/${encodeURIComponent(symbol)}`,
      OrderMarket,
    ),
  )
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

/** The best price on the side an order of `side` would take from. */
export async function bestPrice(
  { phoenix }: TradeContext,
  symbol: string,
  side: Side,
) {
  const book = await forMarket(symbol, () =>
    phoenix.get(`/v1/view/orderbook/${encodeURIComponent(symbol)}`, Orderbook),
  )
  const prices = (side === 'buy' ? book.asks : book.bids).map(
    ([price]) => price,
  )
  if (prices.length === 0) return null
  return decimalString(
    side === 'buy' ? Math.min(...prices) : Math.max(...prices),
  )
}

export { MarketSymbol }
