import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { PrivyClient } from '@privy-io/node'
import { drizzle } from 'drizzle-orm/d1'
import { paymentSigner } from '../db/schema'
import { testDatabase } from '../test-database'
import {
  confirmSigner,
  disableSigner,
  prepareSigner,
  signerStatus,
} from './signer-setup'
import type { PaymentNetwork } from './network'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

test('a confirmation that finishes after a turn-off leaves payments off', async () => {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    status: 'pending',
    updatedAt: Date.now(),
  })
  // Privy still shows the signer, but the user turns payments off while
  // /confirm is waiting for Privy's answer.
  const privy = {
    wallets: () => ({
      get: async () => {
        await disableSigner(db, user)
        return {
          additional_signers: [
            { signer_id: 'signer-1', override_policy_ids: ['policy-1'] },
          ],
        }
      },
    }),
  } as unknown as PrivyClient

  await expect(confirmSigner(db, privy, user, 'signer-1')).rejects.toThrow(
    'turned off',
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
  })
  expect(grant.policyIds).toEqual(['policy-1'])
  expect(create).not.toHaveBeenCalled()
  expect((await signerStatus(db, user)).status).toBe('enabled')
})
