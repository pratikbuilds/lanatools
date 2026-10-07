import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { paymentSigner, transactionSigner } from '../db/schema'
import { testDatabase } from '../test-database'
import { disablePaymentDelegation } from './signer-removal'
import { signerStatus } from './signer-setup'
import type { SignerWalletClient } from './selective-signer'

let database: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db: database, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

async function fixture() {
  const userId = crypto.randomUUID()
  await drizzle(database).insert(paymentSigner).values({
    privyUserId: userId,
    walletId: 'wallet',
    walletAddress: 'address',
    policyId: 'pay-policy',
    status: 'enabled',
    updatedAt: 1,
  })
  await drizzle(database).insert(transactionSigner).values({
    privyUserId: userId,
    walletId: 'wallet',
    walletAddress: 'address',
    signerId: 'sol',
    policyId: 'sol-policy',
    status: 'enabled',
    updatedAt: 1,
  })
  let signers = [
    { signer_id: 'pay', override_policy_ids: ['pay-policy'] },
    { signer_id: 'sol', override_policy_ids: ['sol-policy'] },
  ]
  const update = mock(
    async (
      _id: string,
      input: Parameters<ReturnType<SignerWalletClient['wallets']>['update']>[1],
    ) => {
      expect((await signerStatus(database, userId)).status).toBe('disabled')
      signers = input.additional_signers.map((signer) => ({
        ...signer,
        override_policy_ids: signer.override_policy_ids ?? [],
      }))
      return { address: 'address', additional_signers: signers }
    },
  )
  const privy = {
    wallets: () => ({
      list: async function* () {
        yield { id: 'wallet', address: 'address' }
      },
      get: async () => ({ address: 'address', additional_signers: signers }),
      update,
    }),
  }
  return {
    userId,
    privy,
    update,
    input: {
      userId,
      walletAddress: 'address',
      signerId: 'pay',
      userAccessToken: 'owner-token',
    },
  }
}

test('payment disable stops local authority before selectively removing payments and leaves SOL enabled', async () => {
  const f = await fixture()
  expect(
    (await disablePaymentDelegation(database, f.privy, f.input)).status,
  ).toBe('disabled')
  expect(f.update.mock.calls[0]?.[1].additional_signers).toEqual([
    { signer_id: 'sol', override_policy_ids: ['sol-policy'] },
  ])
  expect(
    (
      await drizzle(database)
        .select()
        .from(transactionSigner)
        .where(eq(transactionSigner.privyUserId, f.userId))
        .get()
    )?.status,
  ).toBe('enabled')
  await disablePaymentDelegation(database, f.privy, f.input)
  expect(f.update).toHaveBeenCalledTimes(1)
})

test('lost removal response leaves payments off and unrelated delegation intact', async () => {
  const f = await fixture()
  f.update.mockImplementation(async () => {
    throw new Error('provider failure')
  })
  await expect(
    disablePaymentDelegation(database, f.privy, f.input),
  ).rejects.toThrow('outcome is unknown')
  expect((await signerStatus(database, f.userId)).status).toBe('disabled')
  expect(
    (
      await drizzle(database)
        .select()
        .from(transactionSigner)
        .where(eq(transactionSigner.privyUserId, f.userId))
        .get()
    )?.status,
  ).toBe('enabled')
})

test('stale wallet address refuses remote update after the local emergency stop', async () => {
  const f = await fixture()
  await expect(
    disablePaymentDelegation(database, f.privy, {
      ...f.input,
      walletAddress: 'old-wallet',
    }),
  ).rejects.toThrow('Refresh your wallet')
  expect((await signerStatus(database, f.userId)).status).toBe('disabled')
  expect(f.update).not.toHaveBeenCalled()
})
