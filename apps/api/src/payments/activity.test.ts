import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'
import { ActivityPage } from '@lanatools/contracts'
import { mcpGrant, paymentActivity } from '../db/schema'
import { testDatabase } from '../test-database'
import { activityDays, listActivity, parseActivityCursor } from './activity'
import type { ActivityCursor } from './activity'

const DAY_MS = 86_400_000
const NOON = Date.UTC(2026, 9, 2, 12)

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

let user: string
beforeEach(() => {
  user = `user-${crypto.randomUUID()}`
})

async function connect(
  clientId: string,
  {
    clientName = 'Codex',
    status = 'active',
  }: { clientName?: string; status?: 'active' | 'revoked' } = {},
) {
  await drizzle(db).insert(mcpGrant).values({
    id: crypto.randomUUID(),
    privyUserId: user,
    clientId,
    clientName,
    status,
    scope: 'account:read payments:pay',
    createdAt: NOON,
  })
}

async function record(call: Partial<typeof paymentActivity.$inferInsert>) {
  const id = call.id ?? crypto.randomUUID()
  await drizzle(db)
    .insert(paymentActivity)
    .values({
      privyUserId: user,
      clientId: 'client-a',
      grantId: 'grant-a',
      method: 'GET',
      origin: 'https://merchant.example',
      path: '/v1/forecast',
      status: 'free',
      createdAt: NOON,
      ...call,
      id,
    })
  return id
}

type Filter = Parameters<typeof listActivity>[2]

const everything: Filter = {
  clientId: undefined,
  outcome: undefined,
  before: undefined,
  limit: 50,
}

test('lists ended calls newest first, as the shared contract', async () => {
  await connect('client-a')
  const paid = await record({
    status: 'paid',
    protocol: 'x402',
    network: 'devnet',
    reservedAtomic: 10_000,
    settledAtomic: 10_000,
    signature: 'sig-1',
    httpStatus: 200,
    createdAt: NOON + 3,
  })
  const refused = await record({
    status: 'refused',
    protocol: 'mpp',
    httpStatus: 402,
    error: 'Payments are turned off for this wallet',
    createdAt: NOON + 2,
  })
  const failed = await record({
    status: 'failed',
    error: 'Could not reach the endpoint',
    createdAt: NOON + 1,
  })
  const free = await record({ httpStatus: 200 })

  const page = ActivityPage.assert(await listActivity(db, user, everything))
  expect(page.items.map((item) => item.id)).toEqual([
    paid,
    refused,
    failed,
    free,
  ])
  expect(page.items[0]).toEqual({
    id: paid,
    clientId: 'client-a',
    clientName: 'Codex',
    connected: true,
    method: 'GET',
    origin: 'https://merchant.example',
    path: '/v1/forecast',
    protocol: 'x402',
    outcome: 'paid',
    network: 'devnet',
    amountMicroUsd: 10_000,
    signature: 'sig-1',
    httpStatus: 200,
    reason: null,
    createdAt: NOON + 3,
  })
  expect(page.items[1]).toMatchObject({
    outcome: 'refused',
    amountMicroUsd: null,
    reason: 'Payments are turned off for this wallet',
  })
  expect(page.items[2]).toMatchObject({
    outcome: 'failed',
    reason: 'Could not reach the endpoint',
  })
  expect(page.items[3]).toMatchObject({ outcome: 'free', amountMicroUsd: null })
  expect(page.nextCursor).toBeNull()
  expect(page.totals).toEqual({ calls: 4, spentMicroUsd: 10_000 })
})

test('a payment in progress or released is neither listed nor counted', async () => {
  const free = await record({})
  for (const status of ['reserved', 'uncertain', 'released'] as const)
    await record({ status, reservedAtomic: 10_000 })

  const page = await listActivity(db, user, everything)
  expect(page.items.map((item) => item.id)).toEqual([free])
  expect(page.totals).toEqual({ calls: 1, spentMicroUsd: 0 })
  expect(await activityDays(db, user, NOON)).toEqual([
    { day: '2026-10-02', calls: 1, spentMicroUsd: 0 },
  ])
})

test("another user's calls are never returned, even by client ID", async () => {
  const mine = await record({})
  const owner = user
  user = `user-${crypto.randomUUID()}`
  await record({ clientId: 'client-a' })

  const page = await listActivity(db, owner, {
    ...everything,
    clientId: 'client-a',
  })
  expect(page.items.map((item) => item.id)).toEqual([mine])
  expect(page.totals.calls).toBe(1)
  expect(await activityDays(db, owner, NOON)).toEqual([
    { day: '2026-10-02', calls: 1, spentMicroUsd: 0 },
  ])
})

test('pages through calls made in the same millisecond without gaps or repeats', async () => {
  await record({ id: 'call-a' })
  await record({ id: 'call-b' })
  await record({ id: 'call-c' })
  await record({ id: 'call-d', createdAt: NOON - 1 })
  await record({ id: 'call-e', createdAt: NOON + 1 })

  const seen: string[] = []
  let before: ActivityCursor | undefined
  for (let pages = 0; pages < 5; pages++) {
    const page = await listActivity(db, user, {
      ...everything,
      before,
      limit: 2,
    })
    seen.push(...page.items.map((item) => item.id))
    // Totals describe the whole selection on every page.
    expect(page.totals.calls).toBe(5)
    if (page.nextCursor === null) break
    const next = parseActivityCursor(page.nextCursor)
    if (!next) throw new Error(`Unreadable cursor ${page.nextCursor}`)
    before = next
  }
  expect(seen).toEqual(['call-e', 'call-c', 'call-b', 'call-a', 'call-d'])
})

test('filters by client and by outcome, with totals for the selection', async () => {
  await record({ id: 'a-paid', status: 'paid', settledAtomic: 10_000 })
  await record({ id: 'a-free' })
  await record({ id: 'a-refused', status: 'refused' })
  await record({ id: 'a-failed', status: 'failed' })
  await record({
    id: 'b-paid',
    clientId: 'client-b',
    status: 'paid',
    settledAtomic: 250_000,
  })

  const select = async (filter: Partial<Filter>) => {
    const page = await listActivity(db, user, { ...everything, ...filter })
    return { ids: page.items.map((item) => item.id).sort(), ...page.totals }
  }
  expect(await select({ outcome: 'paid' })).toEqual({
    ids: ['a-paid', 'b-paid'],
    calls: 2,
    spentMicroUsd: 260_000,
  })
  expect(await select({ outcome: 'free' })).toEqual({
    ids: ['a-free'],
    calls: 1,
    spentMicroUsd: 0,
  })
  expect(await select({ outcome: 'refused' })).toEqual({
    ids: ['a-refused'],
    calls: 1,
    spentMicroUsd: 0,
  })
  expect(await select({ outcome: 'failed' })).toEqual({
    ids: ['a-failed'],
    calls: 1,
    spentMicroUsd: 0,
  })
  expect(await select({ clientId: 'client-b' })).toEqual({
    ids: ['b-paid'],
    calls: 1,
    spentMicroUsd: 250_000,
  })
  expect(await select({ clientId: 'client-b', outcome: 'free' })).toEqual({
    ids: [],
    calls: 0,
    spentMicroUsd: 0,
  })
})

test('a disconnected client keeps its calls and its name', async () => {
  await connect('client-gone', { clientName: 'Grok', status: 'revoked' })
  await record({ clientId: 'client-gone' })
  await record({ clientId: 'client-never-approved', createdAt: NOON - 1 })

  const { items } = await listActivity(db, user, everything)
  expect(items[0]).toMatchObject({ clientName: 'Grok', connected: false })
  expect(items[1]).toMatchObject({ clientName: null, connected: false })
})

test('charts calls and spend per UTC day, inside the window only', async () => {
  const today = NOON - (NOON % DAY_MS)
  await record({ status: 'paid', settledAtomic: 10_000 })
  await record({ status: 'paid', settledAtomic: 30_000, createdAt: today })
  await record({ createdAt: today - 1 })
  await record({ createdAt: today - 83 * DAY_MS })
  await record({ createdAt: today - 83 * DAY_MS - 1 })

  expect(await activityDays(db, user, NOON)).toEqual([
    { day: '2026-07-11', calls: 1, spentMicroUsd: 0 },
    { day: '2026-10-01', calls: 1, spentMicroUsd: 0 },
    { day: '2026-10-02', calls: 2, spentMicroUsd: 40_000 },
  ])
})

test('a cursor is read back only in the form it was issued', () => {
  expect(parseActivityCursor('1790942400000_call-a')).toEqual({
    createdAt: 1_790_942_400_000,
    id: 'call-a',
  })
  for (const value of [
    '',
    'call-a',
    '1790942400000',
    '1790942400000_',
    '_call-a',
    '1e3_call-a',
    "1790942400000_call' or 1=1 --",
  ])
    expect(parseActivityCursor(value)).toBeNull()
})
