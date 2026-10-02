import { EarlyAccessResponse } from '@lanatools/contracts'

type SignupState =
  | { phase: 'edit'; failure: { formId: string; message: string } | null }
  | { phase: 'busy'; email: string }
  | { phase: 'joined'; email: string }

const initialState: SignupState = { phase: 'edit', failure: null }
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

export function clearSignupError(formId: string) {
  if (state.phase === 'edit' && state.failure?.formId === formId)
    publish(initialState)
}

export function resetSignup() {
  pending?.abort()
  pending = null
  publish(initialState)
}

export async function joinEarlyAccess(email: string, formId: string) {
  if (state.phase !== 'edit') return
  const request = new AbortController()
  pending = request
  publish({ phase: 'busy', email })
  let message = 'We couldn’t add you just now. Try again.'
  try {
    const response = await fetch('/api/early-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
    })
    if (response.status === 429)
      message = 'Too many attempts. Wait a minute and try again.'
    if (!response.ok) throw new Error('Signup request failed')
    const saved = EarlyAccessResponse.assert(await response.json())
    if (saved.email !== email) throw new Error('Signup email did not match')
    if (pending === request) publish({ phase: 'joined', email: saved.email })
  } catch {
    if (pending === request)
      publish({
        phase: 'edit',
        failure: { formId, message },
      })
  } finally {
    if (pending === request) pending = null
  }
}
