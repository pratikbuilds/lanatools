import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { readJupiter } from './jupiter'
import {
  activateGrant,
  prepareGrant,
  recordConsent,
  revokeGrant,
} from './mcp-grants'
import { testDatabase } from './test-database'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

async function connect(scopes: string[]) {
  const handle = crypto.randomUUID()
  const clientId = crypto.randomUUID()
  const userId = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId,
    clientName: 'Jupiter test',
    redirectUri: 'https://client.example/callback',
    scopes,
  })
  const { grantId } = await prepareGrant(db, handle, clientId, userId)
  const identity = { grantId, clientId, userId }
  await activateGrant(db, handle, identity)
  return identity
}

const request = {
  tool: 'jupiter_search_tokens' as const,
  input: { query: 'JUP' },
}
test('the API requires stored Jupiter scope and binds access to the grant owner/client', async () => {
  let calls = 0
  const fetcher = () => {
    calls++
    return Promise.resolve(Response.json([]))
  }
  const account = await connect(['account:read'])
  expect(
    await readJupiter(db, account, request, 'test-key', fetcher),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  const grant = await connect(['jupiter:read'])
  expect(
    await readJupiter(
      db,
      { ...grant, clientId: 'other-client' },
      request,
      'test-key',
      fetcher,
    ),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(
    await readJupiter(
      db,
      { ...grant, userId: 'other-user' },
      request,
      'test-key',
      fetcher,
    ),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(calls).toBe(0)
  expect(
    await readJupiter(db, grant, request, 'test-key', fetcher),
  ).toMatchObject({ ok: true, result: { data: { tokens: [] } } })
  expect(calls).toBe(1)
  await revokeGrant(db, grant.userId, grant.grantId)
  expect(
    await readJupiter(db, grant, request, 'test-key', fetcher),
  ).toMatchObject({ ok: false, error: { code: 'permission_denied' } })
  expect(calls).toBe(1)
})

test('a missing provider key fails without fetching or requiring user credentials', async () => {
  const grant = await connect(['jupiter:read'])
  let calls = 0
  expect(
    await readJupiter(db, grant, request, undefined, () => {
      calls++
      return Promise.resolve(Response.json([]))
    }),
  ).toMatchObject({
    ok: false,
    error: { code: 'upstream_unavailable', retryable: false },
  })
  expect(calls).toBe(0)
})
