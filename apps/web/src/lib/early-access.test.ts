import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import {
  joinEarlyAccess,
  resetSignup,
  signupSnapshot,
  subscribeSignup,
} from './early-access'

const fetchSignup = spyOn(globalThis, 'fetch')
afterAll(() => fetchSignup.mockRestore())
afterEach(() => {
  resetSignup()
  fetchSignup.mockReset()
})

function deferredResponse() {
  let resolve: (response: Response) => void
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return {
    fetch: Object.assign(() => promise, { preconnect: fetch.preconnect }),
    finish: (response: Response) => resolve(response),
  }
}

test('one in-flight request synchronizes subscribers and reset ignores stale success', async () => {
  const first = deferredResponse()
  fetchSignup.mockImplementation(first.fetch)
  const states: string[] = []
  const unsubscribe = subscribeSignup(() => states.push(signupSnapshot().phase))
  const old = joinEarlyAccess('old@example.com')
  expect(signupSnapshot()).toEqual({ phase: 'busy', email: 'old@example.com' })
  await joinEarlyAccess('other@example.com')
  expect(fetchSignup).toHaveBeenCalledTimes(1)
  const signal = fetchSignup.mock.calls[0]?.[1]?.signal
  expect(signal?.aborted).toBe(false)
  resetSignup()
  expect(signal?.aborted).toBe(true)
  fetchSignup.mockResolvedValue(
    Response.json({ status: 'saved', email: 'new@example.com' }),
  )
  await joinEarlyAccess('new@example.com')
  first.finish(Response.json({ status: 'saved', email: 'old@example.com' }))
  await old
  expect(signupSnapshot()).toEqual({
    phase: 'joined',
    email: 'new@example.com',
  })
  expect(states).toEqual(['busy', 'edit', 'busy', 'joined'])
  unsubscribe()
  resetSignup()
  expect(states).toEqual(['busy', 'edit', 'busy', 'joined'])
})

test('HTTP failures, malformed confirmations, wrong emails and network errors remain retryable', async () => {
  for (const response of [
    new Response('unavailable', { status: 503 }),
    Response.json({}),
    Response.json({ status: 'queued', email: 'retry@example.com' }),
    Response.json({ status: 'saved', email: 'wrong@example.com' }),
    new Response('invalid json'),
  ]) {
    fetchSignup.mockResolvedValue(response)
    await joinEarlyAccess('retry@example.com')
    expect(signupSnapshot()).toEqual({
      phase: 'edit',
      error: 'We couldn’t add you just now. Try again.',
    })
  }
  fetchSignup.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'))
  await joinEarlyAccess('retry@example.com')
  expect(signupSnapshot().phase).toBe('edit')
  fetchSignup.mockResolvedValue(
    Response.json({ status: 'already-present', email: 'retry@example.com' }),
  )
  await joinEarlyAccess('retry@example.com')
  expect(signupSnapshot()).toEqual({
    phase: 'joined',
    email: 'retry@example.com',
  })
})

test('a stale failure cannot clear the state of a replacement request', async () => {
  const first = deferredResponse()
  const second = deferredResponse()
  fetchSignup
    .mockImplementationOnce(first.fetch)
    .mockImplementationOnce(second.fetch)
  const old = joinEarlyAccess('old@example.com')
  resetSignup()
  const current = joinEarlyAccess('new@example.com')
  first.finish(new Response('', { status: 500 }))
  await old
  expect(signupSnapshot()).toEqual({ phase: 'busy', email: 'new@example.com' })
  second.finish(Response.json({ status: 'saved', email: 'new@example.com' }))
  await current
  expect(signupSnapshot()).toEqual({
    phase: 'joined',
    email: 'new@example.com',
  })
})
