import { HeliusError } from './errors'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const MAX_CURSOR_LENGTH = 16_384

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  return JSON.stringify(value)
}
function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HeliusError('invalid_input')
  const decoded = Uint8Array.from(
    atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    (char) => char.charCodeAt(0),
  )
  // Reject noncanonical encodings, including alternate final padding bits.
  if (base64url(decoded) !== value) throw new HeliusError('invalid_input')
  return decoded
}

/** Authenticate cursors without exposing the platform URL or adding a secret. */
export function createCursorCodec(rpcUrl: string) {
  // Domain-separated key derivation is deterministic across worker restarts.
  const key = crypto.subtle
    .digest(
      'SHA-256',
      encoder.encode(`lanatools:helius:cursor:key:v1\0${rpcUrl}`),
    )
    .then((material) =>
      crypto.subtle.importKey(
        'raw',
        material,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      ),
    )
  async function scope(tool: string, input: Record<string, unknown>) {
    return base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          encoder.encode(canonical({ tool, input })),
        ),
      ),
    )
  }
  return {
    async encode(tool: string, input: Record<string, unknown>, token: string) {
      if (!token) throw new HeliusError('upstream_error')
      const payload = base64url(
        encoder.encode(
          JSON.stringify({
            v: 1,
            scope: await scope(tool, input),
            token,
          }),
        ),
      )
      const signature = base64url(
        new Uint8Array(
          await crypto.subtle.sign('HMAC', await key, encoder.encode(payload)),
        ),
      )
      const result = `${payload}.${signature}`
      if (result.length > MAX_CURSOR_LENGTH)
        throw new HeliusError('upstream_error')
      return result
    },
    async decode(tool: string, input: Record<string, unknown>, cursor: string) {
      try {
        if (cursor.length > MAX_CURSOR_LENGTH) throw new Error('Invalid cursor')
        const parts = cursor.split('.')
        if (parts.length !== 2) throw new Error('Invalid cursor')
        const [payload, signature] = parts as [string, string]
        if (
          !(await crypto.subtle.verify(
            'HMAC',
            await key,
            bytes(signature),
            encoder.encode(payload),
          ))
        )
          throw new Error('Invalid cursor')
        const parsed: unknown = JSON.parse(decoder.decode(bytes(payload)))
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        )
          throw new Error('Invalid cursor')
        const data = parsed as Record<string, unknown>
        if (
          data.v !== 1 ||
          data.scope !== (await scope(tool, input)) ||
          typeof data.token !== 'string' ||
          !data.token
        )
          throw new Error('Invalid cursor')
        return data.token
      } catch {
        throw new HeliusError('invalid_input')
      }
    },
  }
}
