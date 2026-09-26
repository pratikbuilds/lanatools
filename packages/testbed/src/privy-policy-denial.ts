import { APIError } from '@privy-io/node'

export function isPolicyDenial(error: unknown): boolean {
  if (!(error instanceof APIError) || ![400, 403].includes(error.status ?? 0))
    return false

  const body = error.error
  return typeof body === 'object' && body !== null && 'code' in body
    ? body.code === 'policy_violation'
    : false
}
