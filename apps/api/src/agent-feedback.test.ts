import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { saveFeedback } from './agent-feedback'
import { agentFeedback, mcpGrant } from './db/schema'
import { testDatabase } from './test-database'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

async function connect(status: 'active' | 'revoked') {
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    status,
    createdAt: Date.now(),
  })
  return identity
}

const rowsFor = (userId: string) =>
  drizzle(db)
    .select()
    .from(agentFeedback)
    .where(eq(agentFeedback.privyUserId, userId))

test('an active grant saves its feedback with the user, client and grant', async () => {
  const identity = await connect('active')
  expect(await saveFeedback(db, identity, 'Unclear error', 1_000)).toBe(true)
  expect(await rowsFor(identity.userId)).toEqual([
    {
      id: expect.any(String),
      privyUserId: identity.userId,
      clientId: identity.clientId,
      grantId: identity.grantId,
      feedback: 'Unclear error',
      createdAt: 1_000,
    },
  ])
})

test('a revoked grant saves nothing', async () => {
  const identity = await connect('revoked')
  expect(await saveFeedback(db, identity, 'Unclear error')).toBe(false)
  expect(await rowsFor(identity.userId)).toEqual([])
})
