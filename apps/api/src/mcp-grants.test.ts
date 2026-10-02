import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import {
  activateGrant,
  listClients,
  pendingConsent,
  prepareGrant,
  recordConsent,
  revokeGrant,
  setClientLimit,
  useActiveGrant,
} from './mcp-grants'
import { testDatabase } from './test-database'

let db: D1Database
let dispose: () => Promise<void>

beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)

afterAll(() => dispose())

async function startConsent(
  clientId: string,
  redirectUri = 'https://claude.ai/api/mcp/auth_callback',
  scopes = ['account:read'],
) {
  const handle = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId,
    clientName: 'Claude',
    redirectUri,
    scopes,
  })
  return handle
}

async function connect(userId: string, clientId: string) {
  const handle = await startConsent(clientId)
  const { grantId } = await prepareGrant(db, handle, clientId, userId)
  await activateGrant(db, handle, { grantId, userId, clientId }, null)
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
      limitMicroUsd: 0,
      spentMicroUsd: 0,
      reservedMicroUsd: 0,
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
    activateGrant(db, handle, { ...grant, grantId: pending.grantId }, null),
  ).rejects.toThrow('MCP grant changed during authorization')
  expect(await useActiveGrant(db, grant)).toBe(false)
  expect(await listClients(db, 'user-race')).toEqual([])
})

test('consent accepts only known scopes, each once', async () => {
  for (const scopes of [[], ['wallet:drain'], ['account:read', 'account:read']])
    await expect(
      startConsent('client-scopes', undefined, scopes),
    ).rejects.toThrow('Unsupported access request')
  const handle = await startConsent('client-scopes', undefined, [
    'account:read',
    'payments:pay',
  ])
  expect((await pendingConsent(db, handle))?.scopes).toEqual([
    'account:read',
    'payments:pay',
  ])
})

test('a payments grant needs the limit the user approved', async () => {
  const scopes = ['account:read', 'payments:pay']
  const handle = await startConsent('client-pay', undefined, scopes)
  const { grantId } = await prepareGrant(db, handle, 'client-pay', 'user-pay')
  const grant = { grantId, userId: 'user-pay', clientId: 'client-pay' }
  await expect(activateGrant(db, handle, grant, null)).rejects.toThrow(
    'Set a spending limit',
  )
  await activateGrant(db, handle, grant, 2_500_000)
  const [client] = await listClients(db, 'user-pay')
  expect(client?.scopes).toEqual(scopes)
  expect(client?.limitMicroUsd).toBe(2_500_000)

  expect(await setClientLimit(db, 'intruder', grantId, 9_000_000)).toBe(false)
  expect(await setClientLimit(db, 'user-pay', grantId, 500_000)).toBe(true)
  expect((await listClients(db, 'user-pay'))[0]?.limitMicroUsd).toBe(500_000)
})

test('a grant without payments cannot carry or change a limit', async () => {
  const handle = await startConsent('client-read')
  const { grantId } = await prepareGrant(db, handle, 'client-read', 'user-read')
  const grant = { grantId, userId: 'user-read', clientId: 'client-read' }
  await expect(activateGrant(db, handle, grant, 1_000_000)).rejects.toThrow(
    'Unexpected spending limit',
  )
  await activateGrant(db, handle, grant, null)
  expect(await setClientLimit(db, 'user-read', grantId, 1_000_000)).toBe(false)
})

test('older MCP callers can approve read-only access without a spending limit', async () => {
  const handle = await startConsent('legacy-read')
  const { grantId } = await prepareGrant(
    db,
    handle,
    'legacy-read',
    'legacy-user',
  )
  const grant = { grantId, userId: 'legacy-user', clientId: 'legacy-read' }
  await activateGrant(db, handle, grant)
  expect(await useActiveGrant(db, grant)).toBe(true)
  expect((await listClients(db, 'legacy-user'))[0]).toMatchObject({
    clientName: 'Claude',
    limitMicroUsd: 0,
  })

  const paymentHandle = await startConsent('legacy-pay', undefined, [
    'payments:pay',
  ])
  const payment = await prepareGrant(
    db,
    paymentHandle,
    'legacy-pay',
    'legacy-user',
  )
  const paymentGrant = {
    grantId: payment.grantId,
    userId: 'legacy-user',
    clientId: 'legacy-pay',
  }
  await expect(activateGrant(db, paymentHandle, paymentGrant)).rejects.toThrow(
    'Set a spending limit',
  )
  expect(await useActiveGrant(db, paymentGrant)).toBe(false)
})
