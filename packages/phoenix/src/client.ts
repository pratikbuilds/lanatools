import type { z } from 'zod'

/**
 * Reads Phoenix's public perps API (docs.phoenix.trade/api). Every route used
 * here is a public GET: no API key, no wallet signature. Phoenix runs on
 * Solana mainnet only.
 *
 * Responses are untrusted third-party data. They are validated with zod and
 * returned as data, never as instructions.
 */
export const PHOENIX_API_URL = 'https://perp-api.phoenix.trade'

// Per request. Matches the Jupiter package; a tool call makes at most two.
const TIMEOUT_MS = 10_000

export type PhoenixFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>

export type PhoenixOpts = {
  fetch?: PhoenixFetch
  baseURL?: string
  timeoutMs?: number
}

export type PhoenixErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_error'
  // Trade tools only.
  | 'not_activated'
  | 'insufficient_funds'
  | 'market_unavailable'
  // A built instruction failed a safety check: a bug or an SDK change, never
  // the caller's input. Nothing was signed.
  | 'check_failed'

export class PhoenixError extends Error {
  constructor(
    readonly code: PhoenixErrorCode,
    message: string,
  ) {
    super(message)
  }

  get retryable() {
    return this.code === 'rate_limited' || this.code === 'timeout'
  }
}

export type PhoenixClient = ReturnType<typeof createPhoenixClient>

export function createPhoenixClient(opts: PhoenixOpts = {}) {
  const fetcher = opts.fetch ?? fetch
  const baseURL = opts.baseURL ?? PHOENIX_API_URL
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS

  async function request<T extends z.ZodType>(
    url: URL,
    schema: T,
    init: { method?: 'POST'; body?: unknown; token?: string } = {},
  ): Promise<z.output<T>> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    if (init.token) headers.authorization = `Bearer ${init.token}`
    let response: Response
    try {
      response = await fetcher(url.toString(), {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        // Workers only support follow/manual. Reject redirects via status below.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'TimeoutError')
        throw new PhoenixError('timeout', 'Phoenix did not answer in time')
      throw new PhoenixError('upstream_error', 'Could not reach Phoenix')
    }
    if (response.status === 404)
      throw new PhoenixError('not_found', 'Phoenix has no such record')
    if (response.status === 400)
      throw new PhoenixError('invalid_input', 'Phoenix rejected the request')
    if (response.status === 429)
      throw new PhoenixError(
        'rate_limited',
        'Phoenix is rate limiting requests',
      )
    if (!response.ok)
      throw new PhoenixError(
        'upstream_error',
        `Phoenix answered HTTP ${response.status}`,
      )
    const parsed = schema.safeParse(await response.json().catch(() => null))
    if (!parsed.success)
      throw new PhoenixError(
        'upstream_error',
        'Phoenix returned an unexpected response',
      )
    return parsed.data
  }

  function get<T extends z.ZodType>(
    path: string,
    schema: T,
    query: Record<string, string | number | undefined> = {},
  ) {
    const url = new URL(path, baseURL)
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value))
    return request(url, schema)
  }

  /** A JSON POST; only trade tools use it (login and account activation). */
  function post<T extends z.ZodType>(
    path: string,
    schema: T,
    body: unknown,
    { token }: { token?: string } = {},
  ) {
    return request(new URL(path, baseURL), schema, {
      method: 'POST',
      body,
      ...(token ? { token } : {}),
    })
  }

  return { get, post }
}
