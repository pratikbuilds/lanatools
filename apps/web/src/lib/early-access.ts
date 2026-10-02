import { EarlyAccessResponse } from '@lanatools/contracts'

type SignupState =
  | { phase: 'edit'; error: string }
  | { phase: 'busy'; email: string }
  | { phase: 'joined'; email: string }

const initialState: SignupState = { phase: 'edit', error: '' }
let state: SignupState = initialState
let pending: AbortController | null = null
const listeners = new Set<() => void>()

export const signupSnapshot = () => state
export const serverSignupSnapshot = () => initialState

export function subscribeSignup(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: SignupState) {
  state = next
  listeners.forEach((listener) => listener())
}

export function clearSignupError() {
  if (state.phase === 'edit' && state.error) publish(initialState)
}

export function resetSignup() {
  pending?.abort()
  pending = null
  publish(initialState)
}

export async function joinEarlyAccess(email: string) {
  if (state.phase !== 'edit') return
  const request = new AbortController()
  pending = request
  publish({ phase: 'busy', email })
  try {
    const response = await fetch('/api/early-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    })
    if (!response.ok) throw new Error('Signup request failed')
    const saved = EarlyAccessResponse.assert(await response.json())
    if (saved.email !== email) throw new Error('Signup email did not match')
    if (pending === request) publish({ phase: 'joined', email: saved.email })
  } catch {
    if (pending === request)
      publish({
        phase: 'edit',
        error: 'We couldn’t add you just now. Try again.',
      })
  } finally {
    if (pending === request) pending = null
  }
}
