/**
 * Formats base units as a decimal string, truncated (never rounded up) to
 * `maxFraction` digits and padded to `minFraction`.
 */
export function formatUnits(
  amount: bigint,
  decimals: number,
  {
    maxFraction,
    minFraction = 0,
  }: { maxFraction: number; minFraction?: number },
) {
  const base = 10n ** BigInt(decimals)
  const whole = amount / base
  const fraction = (amount % base)
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFraction)
    .replace(/0+$/, '')
    .padEnd(minFraction, '0')
  const grouped = whole.toLocaleString('en-US')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/** Lamports as SOL for display: up to four decimals, with dust shown as such. */
export function formatSol(lamports: bigint) {
  const text = formatUnits(lamports, 9, { maxFraction: 4 })
  return text === '0' && lamports > 0n ? '<0.0001' : text
}
