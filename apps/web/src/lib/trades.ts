import type {
  PerpTrade,
  SwapTrade,
  TransactionActivityItem,
  TransactionReceipt,
} from '@lanatools/contracts'

/** What actually happened, once the API has read it after confirmation. */
type Facts = Pick<TransactionReceipt, 'received' | 'fill'> | null | undefined

/**
 * How the dashboard says what a swap or perp transaction trades, from the
 * typed `review.trade` its tool stored. Items without one (older rows, other
 * tools) return null here and keep the generic rendering.
 */

export function tradeOf(item: TransactionActivityItem) {
  return item.kind === 'agent' ? item.review.trade : undefined
}

/**
 * A confirmed trade whose actual amounts the API has not read yet: a swap's
 * output or a perp order's fill.
 */
export function awaitingFacts(item: TransactionActivityItem) {
  const trade = tradeOf(item)
  if (item.kind !== 'agent' || !trade || item.status !== 'confirmed')
    return false
  if (trade.kind === 'swap') return !item.receipt?.received
  return fillsInItsOwnTransaction(trade) && !item.receipt?.fill
}

/**
 * Market orders and closes fill (or not) inside the transaction that sends
 * them, so their fill carries its signature. A limit order rests on the
 * book and fills later, in other transactions.
 */
export function fillsInItsOwnTransaction(trade: PerpTrade) {
  return (
    trade.action === 'close' ||
    (trade.action === 'order' && trade.orderType === 'market')
  )
}

/** Phoenix names a market by its base, "SOL"; traders read "SOL-PERP". */
export const perpMarket = (symbol: string) => `${symbol}-PERP`

/** A decimal USD string as `$1,240.00`; sub-cent fees keep their digits. */
export function formatUSD(value: string | number, { signed = false } = {}) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return String(value)
  const size = Math.abs(amount)
  const text = size.toLocaleString('en-US', {
    minimumFractionDigits: size > 0 && size < 0.01 ? 0 : 2,
    maximumFractionDigits: size > 0 && size < 0.01 ? 6 : 2,
  })
  const sign = amount < 0 ? '−' : signed && amount > 0 ? '+' : ''
  return `${sign}$${text}`
}

/** Decimal places a price carries, ignoring trailing zeros. */
function decimalsOf(value: string | number) {
  const text =
    typeof value === 'number' ? String(Number(value.toPrecision(12))) : value
  if (/e/i.test(text)) return 8
  return (text.split('.')[1] ?? '').replace(/0+$/, '').length
}

/**
 * A market price at the precision it carries: cents at least, more when
 * the market quotes them, so distinct levels on a sub-cent market never
 * read the same. Money totals use `formatUSD`.
 */
export function formatPrice(value: string | number) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return String(value)
  const text = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(2, decimalsOf(value)),
  })
  return `${amount < 0 ? '−' : ''}$${text}`
}

const side = (trade: PerpTrade) => (trade.side === 'sell' ? 'Sell' : 'Buy')

export function tradeTitle(trade: SwapTrade | PerpTrade) {
  if (trade.kind === 'swap')
    return `Swap ${trade.pay.symbol} → ${trade.receive.symbol}`
  const market = trade.symbol ? perpMarket(trade.symbol) : 'Phoenix'
  switch (trade.action) {
    case 'order':
      return [side(trade), trade.size, market].filter(Boolean).join(' ')
    case 'close':
      return ['Close', trade.closing, trade.size, market]
        .filter(Boolean)
        .join(' ')
    case 'cancel':
      return trade.cancelled === undefined
        ? `Cancel ${market} orders`
        : `Cancel ${trade.cancelled} ${market} order${trade.cancelled === 1 ? '' : 's'}`
    case 'deposit':
      return 'Deposit to Phoenix'
    case 'withdraw':
      return 'Withdraw from Phoenix'
    case 'activate':
      return 'Activate Phoenix account'
  }
}

const STABLECOINS = new Set(['USDC', 'USDT', 'PYUSD', 'USDS'])

/**
 * "1 SOL ≈ 109.52 USDC", once quoted: the price of the token that is not a
 * dollar stablecoin, which is how people quote it.
 */
export function swapRate(trade: SwapTrade, facts?: Facts) {
  const paid = Number(trade.pay.amount)
  const received = Number(facts?.received?.amount ?? trade.receive.estimated)
  if (!(paid > 0) || !(received > 0)) return null
  const invert =
    STABLECOINS.has(trade.pay.symbol) && !STABLECOINS.has(trade.receive.symbol)
  const [base, quote, rate] = invert
    ? [trade.receive.symbol, trade.pay.symbol, paid / received]
    : [trade.pay.symbol, trade.receive.symbol, received / paid]
  const shown = Number(rate.toPrecision(6)).toLocaleString('en-US', {
    maximumFractionDigits: 9,
  })
  return `1 ${base} ${facts?.received ? '=' : '≈'} ${shown} ${quote}`
}

/** A market order's price bound, as the person signing would say it. */
export function worstPriceText(trade: PerpTrade) {
  if (!trade.worstPrice) return null
  return `${trade.side === 'sell' ? 'at least' : 'at most'} ${formatPrice(trade.worstPrice)}`
}

/** The second line of a row: the venue and the one term that matters. */
export function tradeDetail(
  trade: SwapTrade | PerpTrade,
  confirmed: boolean,
  facts?: Facts,
) {
  if (trade.kind === 'swap') {
    const rate = swapRate(trade, facts)
    return rate ? `Jupiter · ${rate}` : 'Jupiter'
  }
  const fill = facts?.fill
  if (fill && (trade.action === 'order' || trade.action === 'close')) {
    const realized = Number(fill.realizedPnlUsdc)
    return `Phoenix · Filled at ${formatPrice(fill.price)}${realized ? `, realized ${formatUSD(realized, { signed: true })}` : ''}`
  }
  switch (trade.action) {
    case 'order':
      if (trade.orderType === 'limit' && trade.limitPrice)
        return `Phoenix · Limit at ${formatPrice(trade.limitPrice)}${trade.postOnly ? ', post only' : ''}`
      return ['Phoenix · Market', worstPriceText(trade)]
        .filter(Boolean)
        .join(', ')
    case 'close':
      return ['Phoenix · Reduce only', worstPriceText(trade)]
        .filter(Boolean)
        .join(', ')
    case 'deposit':
      return 'Phoenix · Into your margin account'
    case 'withdraw':
      return 'Phoenix · To your wallet'
    case 'cancel':
      return confirmed ? 'Phoenix · Resting orders removed' : 'Phoenix'
    case 'activate':
      return 'Phoenix · Trader account'
  }
}

/**
 * Wallet money a trade moves, from the wallet's side. A perp order moves
 * none (its margin stays in Phoenix), so it has no amounts; see
 * `perpNotional`.
 */
export function tradeAmounts(
  trade: SwapTrade | PerpTrade,
  facts?: Facts,
): {
  out: string | null
  in: string | null
} {
  if (trade.kind === 'swap') {
    const received = facts?.received?.amount ?? trade.receive.estimated
    return {
      out: `${trade.pay.amount} ${trade.pay.symbol}`,
      in: received ? `${received} ${trade.receive.symbol}` : null,
    }
  }
  if (trade.action === 'deposit' && trade.amountUsdc)
    return { out: `${trade.amountUsdc} USDC`, in: null }
  if (trade.action === 'withdraw' && trade.amountUsdc)
    return { out: null, in: `${trade.amountUsdc} USDC` }
  return { out: null, in: null }
}

/**
 * An order's size in dollars, shown unsigned since no wallet money moves:
 * what filled once known, else the estimate at the best price.
 */
export function perpNotional(trade: SwapTrade | PerpTrade, facts?: Facts) {
  if (trade.kind !== 'perp') return null
  const fill = facts?.fill
  if (fill) return formatUSD(Number(fill.size) * Number(fill.price))
  return trade.notionalUsd ? formatUSD(trade.notionalUsd) : null
}

/** The order ticket in a perp drawer: label and value, in reading order. */
export function orderTicket(
  trade: PerpTrade,
  facts?: Facts,
): Array<[string, string]> {
  const fill = facts?.fill
  const realized = fill ? Number(fill.realizedPnlUsdc) : 0
  const rows: Array<[string, string | undefined]> = [
    ['Market', trade.symbol && perpMarket(trade.symbol)],
    [
      'Type',
      trade.orderType &&
        (trade.orderType === 'market'
          ? 'Market, fill or cancel'
          : trade.postOnly
            ? 'Limit, post only'
            : 'Limit'),
    ],
    ['Size', trade.size && `${trade.size} ${trade.symbol ?? ''}`.trim()],
    ['Limit price', trade.limitPrice && formatPrice(trade.limitPrice)],
    ['Worst price', worstPriceText(trade) ?? undefined],
    ['Filled', fill && `${fill.size} ${trade.symbol ?? ''}`.trim()],
    ['Fill price', fill && formatPrice(fill.price)],
    [
      'Best price',
      fill ? undefined : trade.bestPrice && formatPrice(trade.bestPrice),
    ],
    ['Notional', perpNotional(trade, facts) ?? undefined],
    [
      fill ? 'Fee paid' : 'Taker fee',
      fill ? formatUSD(fill.feeUsdc) : trade.feeUsd && formatUSD(trade.feeUsd),
    ],
    [
      'Realized PnL',
      realized ? formatUSD(realized, { signed: true }) : undefined,
    ],
    ['Closes', trade.closing && `Your ${trade.closing}`],
    [
      'Reduce only',
      trade.reduceOnly === undefined || trade.action === 'close'
        ? undefined
        : trade.reduceOnly
          ? 'Yes'
          : 'No',
    ],
  ]
  return rows.flatMap(([label, value]) => (value ? [[label, value]] : []))
}
