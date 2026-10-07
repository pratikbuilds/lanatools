import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import type { McpEnv } from '../mcp-service'
import { paymentSigner } from '../db/schema'
import { testDatabase } from '../test-database'
import { signerStatus } from '../payments/signer-setup'

// Bun needs the Cloudflare runtime binding before loading the route's service imports.
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }))
const { createPaymentSignerRoutes } = await import('./payment-signer')
let database: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db: database, dispose } = await testDatabase())
}, 60000)
afterAll(() => dispose())
const env = () => ({ DB: database }) as McpEnv

test('an authenticated legacy empty-body disable stops payments and rejects success before old remove-all code can run', async () => {
  const userId = crypto.randomUUID()
  await drizzle(database).insert(paymentSigner).values({
    privyUserId: userId,
    walletId: 'wallet',
    walletAddress: 'address',
    policyId: 'policy',
    status: 'enabled',
    updatedAt: 1,
  })
  const app = createPaymentSignerRoutes(async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  const response = await app.request('/disable', { method: 'POST' }, env())
  expect(response.status).toBe(409)
  const payload: unknown = await response.json()
  expect(payload).toEqual({
    error:
      'Payments are off. Refresh the dashboard to remove only the payment signer.',
  })
  expect((await signerStatus(database, userId)).status).toBe('disabled')
})

test('an unauthenticated legacy disable cannot stop another user payments', async () => {
  const response = await createPaymentSignerRoutes().request(
    '/disable',
    { method: 'POST' },
    env(),
  )
  expect(response.status).toBe(401)
})

test('a malformed or extra-field request never reaches the privileged signer client', async () => {
  const userId = crypto.randomUUID()
  const app = createPaymentSignerRoutes(async (c, next) => {
    c.set('userId', userId)
    await next()
  })
  for (const body of [
    '{',
    JSON.stringify({ walletAddress: 'address', signerId: 'caller-controlled' }),
  ]) {
    expect(
      (await app.request('/disable', { method: 'POST', body }, env())).status,
    ).toBe(400)
  }
})
