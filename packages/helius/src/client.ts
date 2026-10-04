import { createSolanaRpcFromTransport } from '@solana/kit'
import type { RpcTransport } from '@solana/kit'
import {
  parseJsonWithBigInts,
  stringifyJsonWithBigInts,
} from '@solana/rpc-spec-types'
import { HeliusError } from './errors'
import { record } from './format'

export type HeliusOptions = { rpcUrl: string; fetch?: typeof fetch }
export const TIMEOUT_MS = 10_000
export function createHeliusClient(options: HeliusOptions) {
  let url: URL
  try {
    url = new URL(options.rpcUrl)
  } catch {
    throw new HeliusError('upstream_error')
  }
  if (!['https:', 'http:'].includes(url.protocol))
    throw new HeliusError('upstream_error')
  const request = options.fetch ?? fetch
  let credits = 0
  const transport: RpcTransport = async <TResponse>({
    payload,
    signal,
  }: Parameters<RpcTransport>[0]) => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const abortSignal = signal ? AbortSignal.any([timeout, signal]) : timeout
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stringifyJsonWithBigInts(payload),
        signal: abortSignal,
      })
      if (response.status === 429) throw new HeliusError('rate_limited')
      if (response.status === 403) throw new HeliusError('plan_required')
      if (!response.ok) throw new HeliusError('upstream_error')
      const parsed: unknown = parseJsonWithBigInts(await response.text())
      if (record(parsed).error) {
        const code = record(record(parsed).error).code
        if (code === 429n || code === -32429n || code === -32029n)
          throw new HeliusError('rate_limited')
        if (code === 403n || code === -32003n)
          throw new HeliusError('plan_required')
        throw new HeliusError('upstream_error')
      }
      if (!Object.hasOwn(record(parsed), 'result'))
        throw new HeliusError('upstream_error')
      credits++
      return parsed as TResponse
    } catch (error) {
      if (error instanceof HeliusError) throw error
      if (abortSignal.aborted) throw new HeliusError('timeout')
      throw new HeliusError('upstream_error')
    }
  }
  const rpc = createSolanaRpcFromTransport(transport)
  /** Strip both the URL and key even if a hostile provider echoes them in a result. */
  function redact(value: unknown): unknown {
    if (typeof value === 'string') {
      let safe = value.replaceAll(options.rpcUrl, '[redacted]')
      for (const key of ['api-key', 'api_key']) {
        const secret = url.searchParams.get(key)
        if (secret)
          safe = safe
            .replaceAll(secret, '[redacted]')
            .replaceAll(encodeURIComponent(secret), '[redacted]')
      }
      return safe
    }
    if (Array.isArray(value)) return value.map(redact)
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [String(redact(k)), redact(v)]),
      )
    return value
  }
  return {
    rpc,
    redact,
    get credits() {
      return credits
    },
  }
}
export type HeliusClient = ReturnType<typeof createHeliusClient>
