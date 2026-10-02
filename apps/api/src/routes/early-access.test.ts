import { afterAll, beforeAll, expect, test } from 'bun:test'
import { EarlyAccessResponse } from '@lanatools/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { createApp } from '../app'
import { testDatabase } from '../test-database'
import { earlyAccess } from './early-access'

let db: D1Database
let dispose: () => Promise<void>
const app = createApp<{ DB: D1Database }>().route(
  '/api/early-access',
  earlyAccess,
)

beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

function signup(body: unknown) {
  return app.request(
    '/api/early-access',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DB: db },
  )
}

test('new and normalized duplicate signups persist exactly one row', async () => {
  const response = await signup({ email: '  Tester@Example.com  ' })
  expect(response.status).toBe(200)
  expect<unknown>(await response.json()).toEqual({
    status: 'saved',
    email: 'tester@example.com',
  })
  const row = await db
    .prepare('SELECT * FROM early_access_signup WHERE email = ?')
    .bind('tester@example.com')
    .first()
  expect(row).toEqual({
    email: 'tester@example.com',
    created_at: expect.any(Number),
  })
  const duplicate = await signup({ email: 'tester@example.com' })
  expect(duplicate.status).toBe(200)
  expect(EarlyAccessResponse.assert(await duplicate.json())).toEqual({
    status: 'already-present',
    email: 'tester@example.com',
  })
  expect(
    await db
      .prepare('SELECT * FROM early_access_signup WHERE email = ?')
      .bind('tester@example.com')
      .all(),
  ).toMatchObject({ results: [row] })
})

test('concurrent submissions save one email and confirm every request', async () => {
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => signup({ email: 'race@example.com' })),
  )
  expect(responses.every((response) => response.ok)).toBe(true)
  const results = await Promise.all(
    responses.map(async (response) =>
      EarlyAccessResponse.assert(await response.json()),
    ),
  )
  expect(results.filter((result) => result.status === 'saved')).toHaveLength(1)
  expect(
    results.filter((result) => result.status === 'already-present'),
  ).toHaveLength(4)
  expect(
    await db
      .prepare(
        'SELECT count(*) AS count FROM early_access_signup WHERE email = ?',
      )
      .bind('race@example.com')
      .first<{ count: number }>(),
  ).toEqual({ count: 1 })
})

test('invalid, malformed, and oversized requests cannot create signups', async () => {
  const before = await db
    .prepare('SELECT count(*) AS count FROM early_access_signup')
    .first<{ count: number }>()
  for (const body of [
    null,
    {},
    { email: 123 },
    { email: '' },
    { email: '  ' },
    { email: 'nope@' },
    { email: 'has space@example.com' },
    { email: `${'a'.repeat(250)}@example.com` },
  ])
    expect((await signup(body)).status).toBe(400)
  expect(
    (
      await app.request(
        '/api/early-access',
        { method: 'POST', body: '{' },
        { DB: db },
      )
    ).status,
  ).toBe(400)
  expect((await signup({ email: 'a'.repeat(4096) })).status).toBe(413)
  expect(
    await db
      .prepare('SELECT count(*) AS count FROM early_access_signup')
      .first<{ count: number }>(),
  ).toEqual(before)
})

test('a failed database write returns an error and can be retried', async () => {
  await db
    .prepare('ALTER TABLE early_access_signup RENAME TO unavailable_signup')
    .run()
  try {
    const response = await signup({ email: 'retry@example.com' })
    expect(response.status).toBe(503)
    expect<unknown>(await response.json()).toEqual({
      error: 'Internal server error',
      requestId: response.headers.get('x-request-id'),
    })
  } finally {
    await db
      .prepare('ALTER TABLE unavailable_signup RENAME TO early_access_signup')
      .run()
  }
  expect(
    EarlyAccessResponse.assert(
      await (await signup({ email: 'retry@example.com' })).json(),
    ),
  ).toEqual({
    status: 'saved',
    email: 'retry@example.com',
  })
})
