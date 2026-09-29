import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readdir } from 'node:fs/promises'
import type { D1Database } from '@cloudflare/workers-types'
import { getPlatformProxy } from 'wrangler'
import {
  activateGrant,
  listClients,
  prepareGrant,
  recordConsent,
  revokeGrant,
  useActiveGrant,
} from './mcp-grants'

let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>>
let db: D1Database

beforeAll(async () => {
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: new URL('../wrangler.local.jsonc', import.meta.url).pathname,
    persist: false,
  })
  db = proxy.env.DB
  const dir = new URL('../drizzle/', import.meta.url)
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    for (const statement of (await Bun.file(new URL(file, dir)).text()).split(
      '--> statement-breakpoint',
    ))
      await db.prepare(statement).run()
}, 60_000)

afterAll(() => proxy.dispose())

async function startConsent(
  clientId: string,
  redirectUri = 'https://claude.ai/api/mcp/auth_callback',
) {
  const handle = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId,
    clientName: 'Claude',
    redirectUri,
    scopes: ['account:read'],
  })
  return handle
}

async function connect(userId: string, clientId: string) {
  const handle = await startConsent(clientId)
  const { grantId } = await prepareGrant(db, handle, clientId, userId)
  await activateGrant(db, handle, { grantId, userId, clientId })
  return { grantId, userId, clientId }
}

test('an approved client is listed with its name and redirect host', async () => {
  const grant = await connect('user-list', 'client-list')
  expect(await listClients(db, 'user-list')).toEqual([
    {
      grantId: grant.grantId,
      clientId: 'client-list',
      clientName: 'Claude',
      redirectHost: 'claude.ai',
      scopes: ['account:read'],
      connectedAt: expect.any(Number),
      lastUsedAt: null,
    },
  ])
  expect(await listClients(db, 'someone-else')).toEqual([])
})

test('use is recorded at most every five minutes', async () => {
  const grant = await connect('user-used', 'client-used')
  expect(await useActiveGrant(db, grant, 1_000_000)).toBe(true)
  expect(await useActiveGrant(db, grant, 1_060_000)).toBe(true)
  expect((await listClients(db, 'user-used'))[0]?.lastUsedAt).toBe(1_000_000)
  await useActiveGrant(db, grant, 1_400_000)
  expect((await listClients(db, 'user-used'))[0]?.lastUsedAt).toBe(1_400_000)
})

test('only the owner can revoke, and revocation cuts off access', async () => {
  const grant = await connect('user-revoke', 'client-revoke')
  expect(await revokeGrant(db, 'intruder', grant.grantId)).toBeNull()
  expect(await useActiveGrant(db, grant)).toBe(true)

  expect(await revokeGrant(db, 'user-revoke', grant.grantId)).toBe(
    'client-revoke',
  )
  expect(await useActiveGrant(db, grant)).toBe(false)
  expect(await listClients(db, 'user-revoke')).toEqual([])
  expect(await revokeGrant(db, 'user-revoke', grant.grantId)).toBeNull()
})

test('reconnecting after a revoke never revives the old grant', async () => {
  const old = await connect('user-again', 'client-again')
  await revokeGrant(db, 'user-again', old.grantId)
  const renewed = await connect('user-again', 'client-again')

  expect(renewed.grantId).not.toBe(old.grantId)
  expect(await useActiveGrant(db, old)).toBe(false)
  expect(await useActiveGrant(db, renewed)).toBe(true)
  expect((await listClients(db, 'user-again')).map((c) => c.grantId)).toEqual([
    renewed.grantId,
  ])
})

test('an unapproved request cannot change how a connected app is shown', async () => {
  await connect('user-shown', 'client-shown')
  await startConsent('client-shown', 'https://attacker.example/callback')
  expect((await listClients(db, 'user-shown'))[0]?.redirectHost).toBe(
    'claude.ai',
  )
})

test('a disconnect during another approval stays disconnected', async () => {
  const grant = await connect('user-race', 'client-race')
  const handle = await startConsent('client-race')
  const pending = await prepareGrant(db, handle, 'client-race', 'user-race')
  expect(pending.grantId).toBe(grant.grantId)

  await revokeGrant(db, 'user-race', grant.grantId)
  await expect(
    activateGrant(db, handle, { ...grant, grantId: pending.grantId }),
  ).rejects.toThrow('MCP grant changed during authorization')
  expect(await useActiveGrant(db, grant)).toBe(false)
  expect(await listClients(db, 'user-race')).toEqual([])
})
