import { test, expect } from 'bun:test'
import { APIError } from '@privy-io/node'
import { isPolicyDenial } from './privy-policy-denial'

test('only a structured policy violation counts as a signing denial', () => {
  const response = (status: number, code: string) =>
    new APIError(status, { code }, undefined, new Headers())

  expect(isPolicyDenial(response(403, 'policy_violation'))).toBe(true)
  expect(isPolicyDenial(response(400, 'policy_violation'))).toBe(true)
  expect(isPolicyDenial(response(403, 'policy_not_found'))).toBe(false)
  expect(isPolicyDenial(response(400, 'invalid_data'))).toBe(false)
  expect(isPolicyDenial(response(429, 'policy_violation'))).toBe(false)
  expect(isPolicyDenial(response(503, 'policy_violation'))).toBe(false)
  expect(isPolicyDenial(new Error('policy denied'))).toBe(false)
})
