import { HeliusError } from './errors'

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
export function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
export function number(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'bigint') return null
  const n = Number(value)
  return Number.isFinite(n) &&
    (typeof value !== 'bigint' || Number.isSafeInteger(n))
    ? n
    : null
}
export function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return BigInt(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  throw new HeliusError('upstream_error')
}
export function decimalAmount(value: unknown, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new HeliusError('upstream_error')
  const amount = integer(value)
  const digits = (amount < 0n ? -amount : amount)
    .toString()
    .padStart(decimals + 1, '0')
  const suffix = decimals ? digits.slice(-decimals).replace(/0+$/, '') : ''
  return `${amount < 0n ? '-' : ''}${decimals ? digits.slice(0, -decimals) : digits}${suffix ? `.${suffix}` : ''}`
}
export function lamportsToSol(value: unknown) {
  return decimalAmount(value, 9)
}
export function blockTimeToIso(value: unknown): string | null {
  const seconds = number(value)
  if (seconds === null) return null
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
/** JSON-safe, lossless integers: large values stay decimal strings. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return number(value) ?? value.toString()
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]),
    )
  return value
}
