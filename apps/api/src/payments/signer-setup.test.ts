import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { PrivyClient } from '@privy-io/node'
import { drizzle } from 'drizzle-orm/d1'
import { paymentSigner } from '../db/schema'
import { testDatabase } from '../test-database'
import { eq } from 'drizzle-orm'
import {
  confirmSigner,
  disableSigner,
  prepareSigner,
  signerStatus,
} from './signer-setup'
import type { PaymentNetwork } from '../solana/network'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

function attached(policyId: string) {
  return {
    additional_signers: [
      { signer_id: 'signer-1', override_policy_ids: [policyId] },
    ],
  }
}

test('a confirmation that finishes after setup moved on leaves it pending', async () => {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    status: 'pending',
    updatedAt: Date.now(),
  })
  // Privy still shows the old signer, but a setup for another wallet
  // replaces the row while /confirm is waiting for Privy's answer.
  const privy = {
    wallets: () => ({
      get: async () => {
        await drizzle(db)
          .update(paymentSigner)
          .set({ walletId: 'wallet-2', policyId: 'policy-2' })
          .where(eq(paymentSigner.privyUserId, user))
        return attached('policy-1')
      },
    }),
  } as unknown as PrivyClient

  await expect(confirmSigner(db, privy, user, 'signer-1')).rejects.toThrow(
    'set up again',
  )
  expect((await signerStatus(db, user)).status).toBe('pending')
})

function privyWith(create: () => Promise<{ id: string }>) {
  return {
    wallets: () => ({
      list: async function* () {
        yield { id: 'wallet-1', address: 'wallet-address' }
      },
      get: async () => attached('policy-1'),
    }),
    policies: () => ({ create }),
  } as unknown as PrivyClient
}

async function removedUser() {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    status: 'disabled',
    updatedAt: Date.now(),
  })
  return user
}

const setup = (user: string, restore: boolean) => ({
  userId: user,
  walletAddress: 'wallet-address',
  signerId: 'signer-1',
  network: { usdcMint: 'mint' } as PaymentNetwork,
  restore,
})

test('the automatic setup does not undo a removal', async () => {
  const user = await removedUser()
  const create = mock(async () => ({ id: 'policy-2' }))
  await expect(
    prepareSigner(db, privyWith(create), setup(user, false)),
  ).rejects.toThrow('You removed LanaTools access')
  expect(create).not.toHaveBeenCalled()
  expect((await signerStatus(db, user)).status).toBe('disabled')
})

test('setting up again after a removal reuses its policy, so a signer left on the wallet still matches', async () => {
  const user = await removedUser()
  const create = mock(async () => ({ id: 'policy-2' }))
  const privy = privyWith(create)
  const grant = await prepareSigner(db, privy, setup(user, true))
  expect(grant.policyIds).toEqual(['policy-1'])
  expect(create).not.toHaveBeenCalled()
  expect((await signerStatus(db, user)).status).toBe('pending')
  expect(await confirmSigner(db, privy, user, 'signer-1')).toEqual({
    status: 'enabled',
    walletAddress: 'wallet-address',
  })
})

test('a confirmation that finishes after a removal leaves access removed', async () => {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    status: 'pending',
    updatedAt: Date.now(),
  })
  // Privy still shows the signer, but the user removes access while
  // /confirm is waiting for Privy's answer.
  const privy = {
    wallets: () => ({
      get: async () => {
        await disableSigner(db, user)
        return attached('policy-1')
      },
    }),
  } as unknown as PrivyClient

  await expect(confirmSigner(db, privy, user, 'signer-1')).rejects.toThrow(
    'removed',
  )
  expect((await signerStatus(db, user)).status).toBe('disabled')
})

test('preparing again while payments are on keeps them on', async () => {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    status: 'enabled',
    updatedAt: Date.now(),
  })
  const create = mock(async () => ({ id: 'policy-2' }))
  const privy = {
    wallets: () => ({
      list: async function* () {
        yield { id: 'wallet-1', address: 'wallet-address' }
      },
    }),
    policies: () => ({ create }),
  } as unknown as PrivyClient

  const grant = await prepareSigner(db, privy, {
    userId: user,
    walletAddress: 'wallet-address',
    signerId: 'signer-1',
    network: { usdcMint: 'mint' } as PaymentNetwork,
    restore: false,
  })
  expect(grant.policyIds).toEqual(['policy-1'])
  expect(create).not.toHaveBeenCalled()
  expect((await signerStatus(db, user)).status).toBe('enabled')
})
