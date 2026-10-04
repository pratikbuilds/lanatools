import type { JupiterError } from './types'

export type JupiterFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>
export type JupiterClientOptions = {
  apiKey: string
  fetch?: JupiterFetch
  requestTimeoutMs?: number
  toolTimeoutMs?: number
}

export class JupiterReadError extends Error {
  constructor(readonly detail: JupiterError) {
    super(detail.message)
  }
}

export function unavailable(message = 'Jupiter returned an unusable response') {
  return new JupiterReadError({
    code: 'upstream_unavailable',
    message,
    retryable: false,
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000)
  return Number.isFinite(seconds) ? Math.max(0, seconds) : undefined
}

/** A single tool invocation shares a deadline across reads and enrichment. */
export class ReadContext {
  readonly warnings: string[] = []
  private readonly deadline: number

  constructor(private readonly options: JupiterClientOptions) {
    this.deadline = Date.now() + (options.toolTimeoutMs ?? 30_000)
  }

  async get(
    path: string,
    parameters: Record<string, string> = {},
  ): Promise<unknown> {
    if (!this.options.apiKey.trim())
      throw unavailable('Jupiter access is not configured on the server')
    const url = new URL(path, 'https://api.jup.ag')
    for (const [key, value] of Object.entries(parameters))
      url.searchParams.set(key, value)

    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = this.deadline - Date.now()
      if (remaining <= 0)
        throw new JupiterReadError({
          code: 'upstream_unavailable',
          message: 'Jupiter read timed out',
          retryable: true,
        })
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(this.options.requestTimeoutMs ?? 10_000, remaining),
      )
      let failure: JupiterError
      let delayMs = 250
      try {
        const response = await (this.options.fetch ?? fetch)(url.href, {
          method: 'GET',
          headers: {
            'x-api-key': this.options.apiKey,
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: controller.signal,
        })
        if (response.ok) {
          try {
            return await response.json()
          } catch {
            if (controller.signal.aborted) throw new Error('Read timed out')
            throw unavailable()
          }
        }
        // Never expose provider bodies: errors can contain credentials or HTML.
        await response.body?.cancel()
        const seconds = retryAfter(response.headers.get('Retry-After'))
        const limited = response.status === 429
        failure = {
          code: limited ? 'rate_limited' : 'upstream_unavailable',
          message: limited
            ? 'Jupiter rate limit reached'
            : `Jupiter returned HTTP ${response.status}`,
          retryable: limited || response.status >= 500,
          ...(limited && seconds !== undefined
            ? { retryAfterSeconds: seconds }
            : {}),
        }
        if (limited && seconds !== undefined) delayMs = seconds * 1000
      } catch (error) {
        if (error instanceof JupiterReadError) throw error
        failure = {
          code: 'upstream_unavailable',
          message: 'Jupiter could not be reached',
          retryable: true,
        }
      } finally {
        clearTimeout(timer)
      }
      if (
        !failure.retryable ||
        attempt === 1 ||
        delayMs >= this.deadline - Date.now()
      )
        throw new JupiterReadError(failure)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    throw unavailable()
  }

  tokens(value: unknown) {
    if (!Array.isArray(value)) throw unavailable()
    const records = value.filter(isRecord)
    if (records.length !== value.length)
      this.warnings.push(
        'Jupiter returned non-object token entries; usable records were retained.',
      )
    return records
  }
}
