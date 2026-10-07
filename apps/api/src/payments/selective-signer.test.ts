import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { APIError } from '@privy-io/node'
import { walletSignerRemoval } from '../db/schema'
import { testDatabase } from '../test-database'
import { removeOwnedSigner } from './selective-signer'
import type { SignerWalletClient } from './selective-signer'

let database: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db: database, dispose } = await testDatabase())
}, 60000)
afterAll(() => dispose())
beforeEach(async () => {
  await drizzle(database).delete(walletSignerRemoval)
})

const input = {
  userId: 'owner',
  walletId: 'wallet',
  walletAddress: 'address',
  signerId: 'transaction',
  policyId: 'sol-policy',
  userAccessToken: 'owner-session',
}
const signers = [
  { signer_id: 'payment', override_policy_ids: ['payment-policy'] },
  { signer_id: 'transaction', override_policy_ids: ['sol-policy'] },
  { signer_id: 'unrelated' },
]
function fixture() {
  let current: Parameters<
    ReturnType<SignerWalletClient['wallets']>['update']
  >[1]['additional_signers'] = structuredClone(signers)
  const get = mock(async () => ({
    address: 'address',
    additional_signers: structuredClone(current),
  }))
  const update = mock(
    async (
      _id: string,
      body: Parameters<ReturnType<SignerWalletClient['wallets']>['update']>[1],
    ) => {
      current = structuredClone(body.additional_signers)
      return { address: 'address', additional_signers: current }
    },
  )
  const list = mock(async function* () {
    yield { id: 'wallet', address: 'address' }
  })
  return {
    client: { wallets: () => ({ list, get, update }) },
    get,
    update,
    list,
    set: (value: typeof current) => {
      current = value
    },
  }
}

test('selective owner removal preserves every other signer and exact policy, and uses no server key', async () => {
  const { client, update } = fixture()
  await removeOwnedSigner(database, client, input)
  expect(update).toHaveBeenCalledTimes(1)
  expect(update.mock.calls[0]).toEqual([
    'wallet',
    {
      additional_signers: [
        { signer_id: 'payment', override_policy_ids: ['payment-policy'] },
        { signer_id: 'unrelated' },
      ],
      authorization_context: { user_jwts: ['owner-session'] },
    },
  ])
})

test('missing target is an idempotent read-only success', async () => {
  const f = fixture()
  f.set([{ signer_id: 'payment', override_policy_ids: ['payment-policy'] }])
  await removeOwnedSigner(database, f.client, input)
  expect(f.update).not.toHaveBeenCalled()
})

test('wrong owner, wallet ID or address never updates Privy', async () => {
  for (const field of ['walletId', 'walletAddress'] as const) {
    const f = fixture()
    await expect(
      removeOwnedSigner(database, f.client, { ...input, [field]: 'other' }),
    ).rejects.toThrow('not your embedded wallet')
    expect(f.update).not.toHaveBeenCalled()
  }
  const f = fixture()
  f.list.mockImplementation(async function* () {})
  await expect(removeOwnedSigner(database, f.client, input)).rejects.toThrow(
    'not your embedded wallet',
  )
  expect(f.update).not.toHaveBeenCalled()
})

test('a changed signer snapshot is rejected before list replacement', async () => {
  const f = fixture()
  f.get.mockImplementationOnce(async () => ({
    address: 'address',
    additional_signers: structuredClone(signers),
  }))
  f.get.mockImplementationOnce(async () => ({
    address: 'address',
    additional_signers: [...signers, { signer_id: 'new-owner-signer' }],
  }))
  await expect(removeOwnedSigner(database, f.client, input)).rejects.toThrow(
    'changed',
  )
  expect(f.update).not.toHaveBeenCalled()
})

test('lost provider response and nonmatching post-write state stay unverified without a retry', async () => {
  const failed = fixture()
  failed.update.mockImplementation(async () => {
    throw new Error('provider includes private token')
  })
  await expect(
    removeOwnedSigner(database, failed.client, input),
  ).rejects.toThrow('outcome is unknown')
  expect(failed.update).toHaveBeenCalledTimes(1)
  expect(
    (await drizzle(database).select().from(walletSignerRemoval)).length,
  ).toBe(1)
  await expect(
    removeOwnedSigner(database, failed.client, input),
  ).rejects.toThrow('needs verification')
  expect(failed.update).toHaveBeenCalledTimes(1)
})

test('an acknowledged update with nonmatching post-state remains unverified', async () => {
  const changed = fixture()
  changed.update.mockImplementation(async () => ({
    address: 'address',
    additional_signers: signers,
  }))
  await expect(
    removeOwnedSigner(database, changed.client, input),
  ).rejects.toThrow('could not be verified')
  expect(changed.update).toHaveBeenCalledTimes(1)
})

test('a changed target policy cannot cause removal of a different permission', async () => {
  const f = fixture()
  await expect(
    removeOwnedSigner(database, f.client, {
      ...input,
      policyId: 'other-policy',
    }),
  ).rejects.toThrow('policy changed')
  expect(f.update).not.toHaveBeenCalled()
})

test('two app removals serialize per wallet without restoring a removed signer', async () => {
  const f = fixture()
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  f.update.mockImplementation(async (_walletId, body) => {
    entered()
    await held
    f.set(body.additional_signers)
    return { address: 'address', additional_signers: body.additional_signers }
  })
  const first = removeOwnedSigner(database, f.client, input)
  await started
  await expect(
    removeOwnedSigner(database, f.client, {
      ...input,
      signerId: 'payment',
      policyId: 'payment-policy',
    }),
  ).rejects.toThrow('in progress')
  expect(f.update).toHaveBeenCalledTimes(1)
  release()
  await first
  await removeOwnedSigner(database, f.client, {
    ...input,
    signerId: 'payment',
    policyId: 'payment-policy',
  })
  expect((await f.get()).additional_signers).toEqual([
    { signer_id: 'unrelated' },
  ])
  expect(f.update).toHaveBeenCalledTimes(2)
  expect(
    (await drizzle(database).select().from(walletSignerRemoval)).length,
  ).toBe(0)
})

test('explicit provider rejection releases the guard for owner retry', async () => {
  const f = fixture()
  f.update.mockImplementationOnce(async () => {
    throw new APIError(
      403,
      { code: 'permission_denied' },
      undefined,
      new Headers(),
    )
  })
  await expect(removeOwnedSigner(database, f.client, input)).rejects.toThrow(
    'Execution is off',
  )
  expect(
    (await drizzle(database).select().from(walletSignerRemoval)).length,
  ).toBe(0)
  await removeOwnedSigner(database, f.client, input)
  expect(f.update).toHaveBeenCalledTimes(2)
})
