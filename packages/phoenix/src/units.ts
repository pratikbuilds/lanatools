/**
 * Phoenix stores sizes as integer lots. A market's base lots have
 * `baseLotsDecimals` decimals (SOL: 2, so 2044 lots = 20.44 SOL; kBONK: -2,
 * so 3 lots = 300 kBONK). Quote lots
 * are USDC with 6 decimals (Rise SDK `QUOTE_LOTS_DECIMALS`). Agents get
 * tokens and USDC, never lots: misread lots are the usual cause of
 * wrongly sized orders.
 */
export const QUOTE_LOTS_DECIMALS = 6

/**
 * Exact decimal string for an integer amount with `decimals` decimals.
 * Some markets (kBONK, PUMP) have negative decimals: one lot is 100 tokens.
 */
export function fromLots(lots: string | number, decimals: number): string {
  const value = BigInt(lots)
  if (decimals <= 0) return (value * 10n ** BigInt(-decimals)).toString()
  const negative = value < 0n
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export const usdc = (quoteLots: string | number) =>
  fromLots(quoteLots, QUOTE_LOTS_DECIMALS)

// Phoenix timestamps arrive as ISO strings, Unix seconds or Unix ms.
export function isoTime(value: string | number): string {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value
  const n = Number(value)
  return new Date(n < 1e12 ? n * 1000 : n).toISOString()
}

// Phoenix sends float prices such as 120.94000000000001; trim the noise.
export const tidy = (value: number) => Number(value.toPrecision(10))
