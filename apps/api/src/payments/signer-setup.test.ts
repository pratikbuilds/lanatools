import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import type { PrivyClient } from '@privy-io/node'
import { drizzle } from 'drizzle-orm/d1'
import { paymentSigner } from '../db/schema'
import { transactionPrograms } from '../transactions/tools'
import { testDatabase } from '../test-database'
import { eq } from 'drizzle-orm'
import {
  SignerNotAttachedError,
  SignerSetupError,
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

/** A stored policy that allows USDC transfers of `mint`. */
function policyFor(mint: string) {
  return {
    rules: [
      {
        conditions: [
          {
            field_source: 'solana_token_program_instruction',
            field: 'TransferChecked.mint',
            operator: 'eq',
            value: mint,
          },
        ],
      },
    ],
  }
}

function privyWith(create: () => Promise<{ id: string }>, storedMint = 'mint') {
  return {
    wallets: () => ({
      list: async function* () {
        yield { id: 'wallet-1', address: 'wallet-address' }
      },
      get: async () => attached('policy-1'),
    }),
    policies: () => ({ create, get: async () => policyFor(storedMint) }),
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
  expect(grant.signers).toEqual([
    { signerId: 'signer-1', policyIds: ['policy-1'] },
  ])
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

async function enabledUser() {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    status: 'enabled',
    updatedAt: Date.now(),
  })
  return user
}

test('preparing again while payments are on keeps them on', async () => {
  const user = await enabledUser()
  const create = mock(async () => ({ id: 'policy-2' }))
  const grant = await prepareSigner(db, privyWith(create), setup(user, false))
  expect(grant.signers).toEqual([
    { signerId: 'signer-1', policyIds: ['policy-1'] },
  ])
  expect(create).not.toHaveBeenCalled()
  expect((await signerStatus(db, user)).status).toBe('enabled')
})

test("a stored policy for another network's USDC is replaced", async () => {
  const user = await enabledUser()
  const create = mock(async () => ({ id: 'policy-2' }))
  const grant = await prepareSigner(
    db,
    privyWith(create, 'devnet-mint'),
    setup(user, false),
  )
  expect(grant.signers).toEqual([
    { signerId: 'signer-1', policyIds: ['policy-2'] },
  ])
  expect(create).toHaveBeenCalledTimes(1)
  expect((await signerStatus(db, user)).status).toBe('pending')
})

test('confirming tells the dashboard when the signer has another policy', async () => {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-2',
    status: 'pending',
    updatedAt: Date.now(),
  })
  await expect(
    confirmSigner(
      db,
      privyWith(async () => ({ id: 'unused' })),
      user,
      'signer-1',
    ),
  ).rejects.toBeInstanceOf(SignerNotAttachedError)
})

test('confirming removed access refuses without the not-attached code', async () => {
  const user = await removedUser()
  const error = await confirmSigner(
    db,
    privyWith(async () => ({ id: 'unused' })),
    user,
    'signer-1',
  ).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(SignerSetupError)
  expect(error).not.toBeInstanceOf(SignerNotAttachedError)
  expect((await signerStatus(db, user)).status).toBe('disabled')
})

test('a removal during setup wins over replacing the policy', async () => {
  const user = await enabledUser()
  const create = mock(async () => ({ id: 'policy-2' }))
  const privy = {
    wallets: () => ({
      list: async function* () {
        yield { id: 'wallet-1', address: 'wallet-address' }
      },
    }),
    policies: () => ({
      create,
      // The user removes access while setup asks Privy about the policy.
      get: async () => {
        await disableSigner(db, user)
        return policyFor('devnet-mint')
      },
    }),
  } as unknown as PrivyClient

  await expect(prepareSigner(db, privy, setup(user, false))).rejects.toThrow(
    'removed or set up again meanwhile',
  )
  expect((await signerStatus(db, user)).status).toBe('disabled')
})

/** Privy for a user whose policies answer by ID; `signers` are on the wallet. */
function privyWithPolicies(
  create: (body: unknown) => Promise<{ id: string }>,
  signers: Array<{ signer_id: string; override_policy_ids: string[] }>,
  programs: readonly string[] = transactionPrograms(),
) {
  return {
    wallets: () => ({
      list: async function* () {
        yield { id: 'wallet-1', address: 'wallet-address' }
      },
      get: async () => ({ additional_signers: signers }),
    }),
    policies: () => ({
      create,
      get: async (id: string) =>
        id.startsWith('tx-')
          ? {
              rules: [
                {
                  conditions: [
                    {
                      field_source: 'solana_program_instruction',
                      field: 'programId',
                      operator: 'in',
                      value: [...programs],
                    },
                  ],
                },
              ],
            }
          : policyFor('mint'),
    }),
  } as unknown as PrivyClient
}

test('with a transaction signer, an older setup reads as pending and gains a transaction policy', async () => {
  const user = await enabledUser()
  expect((await signerStatus(db, user)).status).toBe('enabled')
  expect((await signerStatus(db, user, true)).status).toBe('pending')
  const create = mock(async () => ({ id: 'tx-policy-1' }))
  const grant = await prepareSigner(db, privyWithPolicies(create, []), {
    ...setup(user, false),
    transactionSignerId: 'tx-signer',
  })
  expect(grant.signers).toEqual([
    { signerId: 'signer-1', policyIds: ['policy-1'] },
    { signerId: 'tx-signer', policyIds: ['tx-policy-1'] },
  ])
  expect(create).toHaveBeenCalledTimes(1)
  const row = await drizzle(db)
    .select()
    .from(paymentSigner)
    .where(eq(paymentSigner.privyUserId, user))
    .get()
  expect(row).toMatchObject({
    policyId: 'policy-1',
    transactionPolicyId: 'tx-policy-1',
    status: 'pending',
  })
})

test('the transaction policy allows exactly the transaction tool programs', async () => {
  const user = `user-${crypto.randomUUID()}`
  const create = mock(async (body: unknown) => ({
    id: JSON.stringify(body).includes('transactions')
      ? 'tx-policy-1'
      : 'policy-1',
  }))
  await prepareSigner(db, privyWithPolicies(create, []), {
    ...setup(user, false),
    transactionSignerId: 'tx-signer',
  })
  const transactionPolicy = create.mock.calls
    .map(([body]) => body)
    .find((body) => JSON.stringify(body).includes('transactions'))
  expect(transactionPolicy).toMatchObject({
    name: 'LanaTools agent transactions',
    chain_type: 'solana',
    owner: { user_id: user },
    rules: [
      {
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_program_instruction',
            field: 'programId',
            operator: 'in',
            value: transactionPrograms(),
          },
        ],
      },
    ],
  })
  expect(transactionPrograms()).toContain(
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  )
})

test('confirming needs both signers with their policies; a stale transaction policy is replaced', async () => {
  const user = `user-${crypto.randomUUID()}`
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: user,
    walletId: 'wallet-1',
    walletAddress: 'wallet-address',
    policyId: 'policy-1',
    transactionPolicyId: 'tx-policy-1',
    status: 'pending',
    updatedAt: Date.now(),
  })
  const create = mock(async () => ({ id: 'tx-policy-2' }))
  const payment = { signer_id: 'signer-1', override_policy_ids: ['policy-1'] }
  const transactions = {
    signer_id: 'tx-signer',
    override_policy_ids: ['tx-policy-1'],
  }
  await expect(
    confirmSigner(
      db,
      privyWithPolicies(create, [payment]),
      user,
      'signer-1',
      'tx-signer',
    ),
  ).rejects.toBeInstanceOf(SignerNotAttachedError)
  expect(
    await confirmSigner(
      db,
      privyWithPolicies(create, [payment, transactions]),
      user,
      'signer-1',
      'tx-signer',
    ),
  ).toEqual({ status: 'enabled', walletAddress: 'wallet-address' })

  // Preparing again keeps a policy for the current programs...
  const same = await prepareSigner(db, privyWithPolicies(create, []), {
    ...setup(user, false),
    transactionSignerId: 'tx-signer',
  })
  expect(same.signers[1]).toEqual({
    signerId: 'tx-signer',
    policyIds: ['tx-policy-1'],
  })
  expect(create).not.toHaveBeenCalled()
  expect((await signerStatus(db, user, true)).status).toBe('enabled')
  // ...and replaces one made for other programs.
  const replaced = await prepareSigner(
    db,
    privyWithPolicies(create, [], ['11111111111111111111111111111111']),
    { ...setup(user, false), transactionSignerId: 'tx-signer' },
  )
  expect(replaced.signers[1]?.policyIds).toEqual(['tx-policy-2'])
  expect((await signerStatus(db, user, true)).status).toBe('pending')
})
