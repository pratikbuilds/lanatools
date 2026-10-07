import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { PrivyClient } from '@privy-io/node'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { paymentSigner } from '../db/schema'
import { testDatabase } from '../test-database'
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

test('payment re-enable retains the old policy while its signer still needs removal', async () => {
  const user = crypto.randomUUID()
  const walletId = crypto.randomUUID()
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId,
    walletAddress: 'wallet-address',
    policyId: 'old-policy',
    status: 'disabled',
    updatedAt: 1,
  })
  const create = mock(async () => ({ id: 'new-policy' }))
  const privy = {
    wallets: () => ({
      list: async function* () {
        yield { id: walletId, address: 'wallet-address' }
      },
      get: async () => ({
        address: 'wallet-address',
        additional_signers: [
          { signer_id: 'pay', override_policy_ids: ['old-policy'] },
        ],
      }),
    }),
    policies: () => ({ create }),
  } as unknown as PrivyClient
  await expect(
    prepareSigner(db, privy, {
      userId: user,
      walletAddress: 'wallet-address',
      signerId: 'pay',
      network: { usdcMint: 'mint' } as PaymentNetwork,
    }),
  ).rejects.toThrow('Remove the remaining payment signer')
  expect(create).not.toHaveBeenCalled()
  expect(
    (
      await drizzle(db)
        .select()
        .from(paymentSigner)
        .where(eq(paymentSigner.privyUserId, user))
        .get()
    )?.policyId,
  ).toBe('old-policy')
})

test('a late payment policy creation cannot overwrite an owner stop', async () => {
  const user = crypto.randomUUID(),
    walletId = crypto.randomUUID()
  const create = mock(async () => {
    await disableSigner(db, user)
    return { id: 'new-policy' }
  })
  const privy = {
    wallets: () => ({
      list: async function* () {
        yield { id: walletId, address: 'wallet-address' }
      },
    }),
    policies: () => ({ create }),
  } as unknown as PrivyClient
  await expect(
    prepareSigner(db, privy, {
      userId: user,
      walletAddress: 'wallet-address',
      signerId: 'pay',
      network: { usdcMint: 'mint' } as PaymentNetwork,
    }),
  ).rejects.toThrow('stopped or changed')
  expect((await signerStatus(db, user)).status).toBe('disabled')
})

test('concurrent or ambiguous payment preparation cannot create another policy without explicit cancellation', async () => {
  const user = crypto.randomUUID(),
    walletId = crypto.randomUUID()
  let entered: () => void = () => {},
    release: () => void = () => {}
  const started = new Promise<void>((resolve) => {
      entered = resolve
    }),
    held = new Promise<void>((resolve) => {
      release = resolve
    })
  const create = mock(async () => {
    entered()
    await held
    return { id: 'new-policy' }
  })
  const privy = {
    wallets: () => ({
      list: async function* () {
        yield { id: walletId, address: 'wallet-address' }
      },
    }),
    policies: () => ({ create }),
  } as unknown as PrivyClient
  const input = {
    userId: user,
    walletAddress: 'wallet-address',
    signerId: 'pay',
    network: { usdcMint: 'mint' } as PaymentNetwork,
  }
  const first = prepareSigner(db, privy, input)
  await started
  await expect(prepareSigner(db, privy, input)).rejects.toThrow(
    'pending or unknown',
  )
  expect(create).toHaveBeenCalledTimes(1)
  release()
  expect((await first).policyIds).toEqual(['new-policy'])
})
