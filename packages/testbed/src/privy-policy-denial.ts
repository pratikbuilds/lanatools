import { APIError } from '@privy-io/node'

export function isPolicyDenial(error: unknown): boolean {
  if (error instanceof APIError)
    return [400, 403].includes(error.status ?? 0) && hasPolicyCode(error.error)

  if (
    !(error instanceof Error) ||
    !('code' in error) ||
    error.code !== 'SIGNER_REMOTE_API_ERROR' ||
    (error.message !== 'Privy API error: 403' &&
      error.message !== 'Privy API error: 400') ||
    !('context' in error)
  )
    return false

  const response = (error.context as { response?: unknown } | undefined)
    ?.response
  if (typeof response !== 'string') return false
  try {
    return hasPolicyCode(JSON.parse(response))
  } catch {
    return false
  }
}

function hasPolicyCode(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false
  if ('code' in body && body.code === 'policy_violation') return true
  return 'error' in body && hasPolicyCode(body.error)
}
