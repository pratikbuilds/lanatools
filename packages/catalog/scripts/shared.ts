import type { JevOpts } from '../src/index'

// The TypeSafe JS SDK's default per-attempt timeout. The MCP server will
// use its own value, picked from the latency these scripts measure.
const TIMEOUT_MS = 10_000
// TypeSafe's listed price for jev-1.13: $0.042 per million input tokens.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

export function jevOpts(): JevOpts | null {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim()
  return apiKey ? { apiKey, timeoutMs: TIMEOUT_MS } : null
}

export const usd = (inputTokens: number) =>
  `$${(inputTokens * USD_PER_INPUT_TOKEN).toFixed(5)}`

export function printEndpoint(
  e: {
    method: string
    path: string
    price_usd: { min: number; max: number } | null
  },
  note: string,
) {
  const price = e.price_usd ? `$${e.price_usd.min}` : 'no price'
  console.log(
    `       ${note.padEnd(6)} ${`${e.method} ${e.path}`.padEnd(48)} ${price}`,
  )
}
