/**
 * Rules for requests LanaTools sends to endpoints an agent names. The
 * endpoint is untrusted: it gets only what the agent asked to send, never a
 * LanaTools token or server secret, and its answer is size-capped.
 */

export const REQUEST_TIMEOUT_MS = 15_000
export const MAX_RESPONSE_BYTES = 64 * 1024
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

// Headers an agent may set. Everything else, including Authorization and
// Cookie, is refused rather than silently dropped.
const ALLOWED_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
])

export class OutboundRequestError extends Error {
  override readonly name = 'OutboundRequestError'
}

/**
 * Accepts only public https URLs on the default port. Hostnames that name a
 * loopback, private or link-local address are refused here. A public name
 * that resolves to a private address cannot be reached from Cloudflare's
 * edge, which has no route to private networks.
 */
export function checkEndpoint(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new OutboundRequestError('url must be an absolute https URL')
  }
  if (url.protocol !== 'https:')
    throw new OutboundRequestError('url must use https')
  if (url.username || url.password)
    throw new OutboundRequestError('url must not contain credentials')
  if (url.port) throw new OutboundRequestError('url must use the default port')
  if (isPrivateHost(url.hostname))
    throw new OutboundRequestError(
      'url must not point to a local or private network address',
    )
  url.hash = ''
  return url
}

export function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('[')) return !isPublicIpv6(host.slice(1, -1))
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    !host.includes('.')
  )
    return true
  const octets = ipv4(host)
  return octets ? !isPublicIpv4(octets) : false
}

function ipv4(host: string) {
  // WHATWG URL parsing already normalises hex, octal and short forms.
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part)))
    return null
  return parts.map(Number)
}

function isPublicIpv4([a = 0, b = 0]: number[]) {
  return !(
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  )
}

function isPublicIpv6(host: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host)?.[1]
  if (mapped) {
    const octets = ipv4(mapped)
    return octets ? isPublicIpv4(octets) : false
  }
  // Only global unicast (2000::/3) is public.
  return /^[23][0-9a-f]{0,3}:/i.test(host)
}

export type OutboundInput = {
  method: 'GET' | 'POST'
  headers?: Record<string, string> | undefined
  body?: string | Record<string, unknown> | unknown[] | undefined
}

/** Builds the fetch options for the agent's request, or refuses it. */
export function requestInit(input: OutboundInput): RequestInit {
  const headers = new Headers()
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!ALLOWED_HEADERS.has(name.toLowerCase()))
      throw new OutboundRequestError(
        `Header ${name} is not allowed; use ${[...ALLOWED_HEADERS].join(', ')}`,
      )
    headers.set(name, value)
  }
  let body: string | undefined
  if (input.body !== undefined) {
    if (input.method === 'GET')
      throw new OutboundRequestError('A GET request cannot have a body')
    if (typeof input.body === 'string') body = input.body
    else {
      body = JSON.stringify(input.body)
      if (!headers.has('content-type'))
        headers.set('content-type', 'application/json')
    }
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES)
      throw new OutboundRequestError('Request body is too large')
  }
  // Redirects are returned, not followed, so a redirect cannot lead the
  // request, or a payment, to another host.
  return {
    method: input.method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body }),
  }
}

/** Reads at most MAX_RESPONSE_BYTES of a response body as text. */
export async function readCapped(response: Response) {
  if (!response.body) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = MAX_RESPONSE_BYTES - size
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room))
      truncated = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    size += value.byteLength
  }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}
