import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { APIError } from '@privy-io/node'
import type { PrivyClient } from '@privy-io/node'
import {
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getSignatureFromTransaction,
} from '@solana/kit'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import {
  mcpGrant,
  paymentSigner,
  transactionSigner,
  walletSignerRemoval,
} from '../db/schema'
import { PAYMENT_NETWORKS } from '../solana/network'
import {
  executeEmbeddedSol,
  getTransferStatus,
  resolveEmbeddedAuthority,
} from './embedded-sol'
import { verifySignedSolTransfer } from './sol-execution'
import { testDatabase } from '../test-database'
import type { EmbeddedSolEnv } from './embedded-sol'
import {
  confirmSigner,
  disableSigner,
  prepareSigner,
  signerStatus,
} from './signer-setup'
import type { TransactionSignerClient } from './signer-setup'

const ADDRESS = 'So11111111111111111111111111111111111111112'
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

function environment(): EmbeddedSolEnv {
  return {
    DB: db,
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: 'https://rpc.invalid',
    PRIVY_APP_ID: 'test-app',
    PRIVY_APP_SECRET: 'test-secret',
    PRIVY_PAYMENT_SIGNER_ID: 'payments',
    PRIVY_PAYMENT_SIGNER_KEY: 'payment-key',
    SOL_TRANSACTION_SIGNING_ENABLED: 'true',
    PRIVY_TRANSACTION_SIGNER_ID: 'transactions',
    PRIVY_TRANSACTION_SIGNER_KEY: 'transaction-key',
  }
}
function fixture() {
  const userId = crypto.randomUUID(),
    walletId = 'wallet-' + userId
  const env = environment()
  let listed = [{ id: walletId, address: ADDRESS }]
  let wallet: Awaited<
    ReturnType<ReturnType<TransactionSignerClient['wallets']>['get']>
  > = {
    address: ADDRESS,
    additional_signers: [
      { signer_id: 'payments', override_policy_ids: ['payment-policy'] },
    ],
  }
  let policy: Awaited<
    ReturnType<ReturnType<TransactionSignerClient['policies']>['get']>
  > = {
    id: 'policy-' + userId,
    chain_type: 'solana',
    version: '1.0',
    owner_id: 'owner-quorum',
    rules: [
      {
        id: 'rule',
        name: 'Native transfer',
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_system_program_instruction',
            field: 'instructionName',
            operator: 'eq',
            value: 'Transfer',
          },
        ],
      },
    ],
  }
  let quorum: Awaited<
    ReturnType<ReturnType<TransactionSignerClient['keyQuorums']>['get']>
  > = {
    id: 'owner-quorum',
    user_ids: [userId],
    authorization_keys: [],
    authorization_threshold: 1,
  }
  let afterGet: (() => Promise<void>) | undefined
  let afterCreate: (() => Promise<void>) | undefined
  const create = mock(
    async (
      _input: Parameters<
        ReturnType<TransactionSignerClient['policies']>['create']
      >[0],
    ) => {
      if (afterCreate) await afterCreate()
      return { id: policy.id }
    },
  )
  const get = mock(async (_id: string) => {
    const result = wallet
    if (afterGet) await afterGet()
    return result
  })
  const update = mock(
    async (
      _id: string,
      input: Parameters<
        ReturnType<TransactionSignerClient['wallets']>['update']
      >[1],
    ) => {
      wallet = { ...wallet, additional_signers: input.additional_signers }
      return wallet
    },
  )
  const list = mock((input: { user_id: string; chain_type: 'solana' }) =>
    (async function* () {
      expect(input).toEqual({ user_id: userId, chain_type: 'solana' })
      for (const item of listed) yield item
    })(),
  )
  const client: TransactionSignerClient = {
    wallets: () => ({ list, get, update }),
    policies: () => ({ create, get: async () => policy }),
    keyQuorums: () => ({ get: async () => quorum }),
  }
  const input = { userId, walletAddress: ADDRESS }
  return {
    env,
    client,
    input,
    walletId,
    create,
    update,
    list,
    attach: () => {
      wallet = {
        ...wallet,
        additional_signers: [
          ...wallet.additional_signers,
          { signer_id: 'transactions', override_policy_ids: [policy.id] },
        ],
      }
    },
    setWallet: (next: typeof wallet) => {
      wallet = next
    },
    setListed: (next: typeof listed) => {
      listed = next
    },
    setPolicy: (next: typeof policy) => {
      policy = next
    },
    setQuorum: (next: typeof quorum) => {
      quorum = next
    },
    quorum: () => quorum,
    policy: () => policy,
    wallet: () => wallet,
    onGet: (callback: () => Promise<void>) => {
      afterGet = callback
    },
    onCreate: (callback: () => Promise<void>) => {
      afterCreate = callback
    },
  }
}

test('configuration fails closed before provider calls and status reports availability', async () => {
  for (const change of [
    { SOL_TRANSACTION_SIGNING_ENABLED: 'false' },
    { SOLANA_NETWORK: 'mainnet' },
    { PRIVY_TRANSACTION_SIGNER_ID: 'payments' },
    { PRIVY_TRANSACTION_SIGNER_KEY: 'payment-key' },
  ]) {
    const f = fixture(),
      env = { ...f.env, ...change }
    expect(await signerStatus(env, f.input.userId)).toEqual({
      status: 'none',
      walletAddress: null,
      setupAvailable: false,
    })
    await expect(prepareSigner(env, f.client, f.input)).rejects.toThrow(
      'unavailable',
    )
    await expect(confirmSigner(env, f.client, f.input)).rejects.toThrow(
      'unavailable',
    )
    expect(f.list).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
  }
})

test('policy is user-owned native SOL Transfer only and repeat preparation reuses it', async () => {
  const f = fixture()
  const grant = await prepareSigner(f.env, f.client, f.input)
  expect(grant).toEqual({
    signerId: 'transactions',
    policyIds: [f.policy().id],
  })
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({
    chain_type: 'solana',
    version: '1.0',
    owner: { user_id: f.input.userId },
    rules: [
      {
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_system_program_instruction',
            field: 'instructionName',
            operator: 'eq',
            value: 'Transfer',
          },
        ],
      },
    ],
  })
  expect(await signerStatus(f.env, f.input.userId)).toEqual({
    status: 'pending',
    walletAddress: ADDRESS,
    setupAvailable: true,
  })
  expect(await prepareSigner(f.env, f.client, f.input)).toEqual(grant)
  f.attach()
  await confirmSigner(f.env, f.client, f.input)
  expect(await prepareSigner(f.env, f.client, f.input)).toEqual(grant)
  expect(f.create).toHaveBeenCalledTimes(1)
})

test('simultaneous preparation creates one policy; disabled setup creates a fresh one', async () => {
  const f = fixture()
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => prepareSigner(f.env, f.client, f.input)),
  )
  expect(
    results.filter((r) => r.status === 'fulfilled').length,
  ).toBeGreaterThan(0)
  expect(f.create).toHaveBeenCalledTimes(1)
  await disableSigner(f.env, f.client, {
    ...f.input,
    userAccessToken: 'owner-token',
  })
  const previous = f.policy().id
  f.setPolicy({ ...f.policy(), id: 'fresh-policy' })
  const grant = await prepareSigner(f.env, f.client, f.input)
  expect(grant.policyIds).toEqual(['fresh-policy'])
  expect(grant.policyIds).not.toContain(previous)
  expect(f.create).toHaveBeenCalledTimes(2)
})

test('wrong owner/address, duplicate address and changing wallet ID cannot prepare or confirm', async () => {
  const f = fixture()
  f.setListed([])
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'not your',
  )
  f.setListed([{ id: f.walletId, address: OTHER }])
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'not your',
  )
  f.setListed([
    { id: f.walletId, address: ADDRESS },
    { id: 'second', address: ADDRESS },
  ])
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'not your',
  )
  expect(f.create).not.toHaveBeenCalled()
  f.setListed([{ id: f.walletId, address: ADDRESS }])
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  f.setListed([{ id: 'changed-id', address: ADDRESS }])
  await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
    'not your',
  )
  await expect(
    confirmSigner(f.env, f.client, { ...f.input, walletAddress: OTHER }),
  ).rejects.toThrow('current embedded')
  await expect(
    confirmSigner(f.env, f.client, { ...f.input, userId: 'intruder' }),
  ).rejects.toThrow('current embedded')
  expect((await signerStatus(f.env, f.input.userId)).status).toBe('pending')
})

test('confirm refuses absent, duplicate, payment signer and extra override policies', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  for (const signers of [
    [],
    [{ signer_id: 'payments', override_policy_ids: [f.policy().id] }],
    [
      {
        signer_id: 'transactions',
        override_policy_ids: [f.policy().id, 'extra'],
      },
    ],
    [
      { signer_id: 'transactions', override_policy_ids: [f.policy().id] },
      { signer_id: 'transactions', override_policy_ids: [f.policy().id] },
    ],
  ]) {
    f.setWallet({ address: ADDRESS, additional_signers: signers })
    await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
      'exactly this policy',
    )
  }
  f.attach()
  f.setWallet({ ...f.wallet(), address: OTHER })
  await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
    'wallet changed',
  )
})

test('confirm rejects modified methods/programs, extra rules and app-owned policies', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  const original = f.policy(),
    rule = original.rules[0]
  if (!rule) throw new Error('Missing rule fixture')
  for (const policy of [
    { ...original, owner_id: null },
    { ...original, chain_type: 'ethereum' as const },
    { ...original, rules: [{ ...rule, method: 'signMessage' as const }] },
    { ...original, rules: [rule, rule] },
    {
      ...original,
      rules: [
        {
          ...rule,
          conditions: [
            {
              field_source: 'solana_program_instruction' as const,
              field: 'programId' as const,
              operator: 'eq' as const,
              value: ADDRESS,
            },
          ],
        },
      ],
    },
  ]) {
    f.setPolicy(policy)
    await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
      'native SOL',
    )
  }
})

test('late confirmation cannot re-enable a disabled or replaced policy', async () => {
  for (const change of [
    { status: 'disabled' as const },
    { policyId: 'replacement-policy' },
  ]) {
    const f = fixture()
    await prepareSigner(f.env, f.client, f.input)
    f.attach()
    f.onGet(async () => {
      await drizzle(db)
        .update(transactionSigner)
        .set(change)
        .where(eq(transactionSigner.privyUserId, f.input.userId))
    })
    await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
      'disabled or replaced',
    )
    expect((await signerStatus(f.env, f.input.userId)).status).not.toBe(
      'enabled',
    )
  }
})

test('disable works while configuration is off, preserves payment authority and uses owner JWT transiently', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  await confirmSigner(f.env, f.client, f.input)
  const status = await disableSigner(
    { ...f.env, SOL_TRANSACTION_SIGNING_ENABLED: 'false' },
    f.client,
    { ...f.input, userAccessToken: 'owner-token' },
  )
  expect(status).toEqual({
    status: 'disabled',
    walletAddress: ADDRESS,
    setupAvailable: false,
  })
  expect(f.wallet().additional_signers).toEqual([
    { signer_id: 'payments', override_policy_ids: ['payment-policy'] },
  ])
  expect(f.update.mock.calls[0]?.[1].authorization_context).toEqual({
    user_jwts: ['owner-token'],
  })
  const row = await drizzle(db)
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, f.input.userId))
    .get()
  expect(JSON.stringify(row)).not.toContain('owner-token')
})

test('provider removal failure leaves local signing disabled', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  f.update.mockImplementation(async () => {
    throw new Error('sensitive-provider-secret')
  })
  await expect(
    disableSigner(f.env, f.client, {
      ...f.input,
      userAccessToken: 'owner-token',
    }),
  ).rejects.toThrow('outcome is unknown')
  expect((await signerStatus(f.env, f.input.userId)).status).toBe('disabled')
})

test('late policy creation cannot replace a local stop and unknown creation is not repeated', async () => {
  const f = fixture()
  f.onCreate(async () => {
    await drizzle(db)
      .update(transactionSigner)
      .set({ status: 'disabled' })
      .where(eq(transactionSigner.privyUserId, f.input.userId))
  })
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'disabled or replaced',
  )
  expect((await signerStatus(f.env, f.input.userId)).status).toBe('disabled')
  const unknown = fixture()
  unknown.create.mockImplementation(async () => {
    throw new Error('private-provider-error')
  })
  await expect(
    prepareSigner(unknown.env, unknown.client, unknown.input),
  ).rejects.toThrow('could not be completed')
  await expect(
    prepareSigner(unknown.env, unknown.client, unknown.input),
  ).rejects.toThrow('outcome is unknown')
  expect(unknown.create).toHaveBeenCalledTimes(1)
})

test('confirm rejects policy authority shared with other users, keys or nested quorums', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  const owner = f.quorum()
  for (const quorum of [
    { ...owner, user_ids: ['other-user'] },
    { ...owner, user_ids: [f.input.userId, 'other-user'] },
    {
      ...owner,
      authorization_keys: [{ public_key: 'server-key', display_name: null }],
    },
    { ...owner, key_quorum_ids: ['shared-quorum'] },
    { ...owner, authorization_threshold: null },
  ]) {
    f.setQuorum(quorum)
    await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
      'owned only',
    )
  }
  expect((await signerStatus(f.env, f.input.userId)).status).toBe('pending')
})

test('stale wallet disable stops local signing without touching provider state; no record is harmless', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  await confirmSigner(f.env, f.client, f.input)
  await expect(
    disableSigner(f.env, f.client, {
      ...f.input,
      walletAddress: OTHER,
      userAccessToken: 'owner-token',
    }),
  ).rejects.toThrow('SOL is off')
  expect((await signerStatus(f.env, f.input.userId)).status).toBe('disabled')
  expect(f.update).not.toHaveBeenCalled()
  const empty = fixture()
  expect(
    (
      await disableSigner(empty.env, empty.client, {
        ...empty.input,
        userAccessToken: 'owner-token',
      })
    ).status,
  ).toBe('none')
  expect(empty.list).not.toHaveBeenCalled()
})

test('existing setup cannot silently change its configured signer or wallet ID', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  await expect(
    prepareSigner(
      { ...f.env, PRIVY_TRANSACTION_SIGNER_ID: 'different-transaction-signer' },
      f.client,
      f.input,
    ),
  ).rejects.toThrow('previous transaction setup')
  await expect(
    confirmSigner(
      { ...f.env, PRIVY_TRANSACTION_SIGNER_ID: 'different-transaction-signer' },
      f.client,
      f.input,
    ),
  ).rejects.toThrow('current embedded wallet')
  f.setListed([{ id: 'new-owner-wallet', address: ADDRESS }])
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'previous transaction setup',
  )
  expect(f.create).toHaveBeenCalledTimes(1)
  const missing = fixture()
  delete missing.env.SOL_TRANSACTION_SIGNING_ENABLED
  await expect(
    prepareSigner(missing.env, missing.client, missing.input),
  ).rejects.toThrow('unavailable')
  expect(missing.list).not.toHaveBeenCalled()
})

test('failed removal preserves the old policy until retry removes its signer', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  await confirmSigner(f.env, f.client, f.input)
  const policyId = f.policy().id
  f.update.mockImplementation(async () => {
    throw new APIError(403, { error: 'forbidden' }, 'Forbidden', new Headers())
  })
  await expect(
    disableSigner(f.env, f.client, {
      ...f.input,
      userAccessToken: 'owner-token',
    }),
  ).rejects.toThrow('off')
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'remaining transaction signer',
  )
  const row = await drizzle(db)
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, f.input.userId))
    .get()
  expect(row?.status).toBe('disabled')
  expect(row?.policyId).toBe(policyId)
  expect(f.create).toHaveBeenCalledTimes(1)
  f.update.mockImplementation(async (_id, input) => {
    const wallet = {
      ...f.wallet(),
      additional_signers: input.additional_signers,
    }
    f.setWallet(wallet)
    return wallet
  })
  await disableSigner(f.env, f.client, {
    ...f.input,
    userAccessToken: 'owner-token',
  })
  expect(f.wallet().additional_signers).toEqual([
    { signer_id: 'payments', override_policy_ids: ['payment-policy'] },
  ])
  f.setPolicy({ ...f.policy(), id: 'fresh-after-removal' })
  expect((await prepareSigner(f.env, f.client, f.input)).policyIds).toEqual([
    'fresh-after-removal',
  ])
})

test('ambiguous removal prevents setup or retry from losing the old policy binding', async () => {
  const f = fixture()
  await prepareSigner(f.env, f.client, f.input)
  f.attach()
  await confirmSigner(f.env, f.client, f.input)
  const policyId = f.policy().id
  f.update.mockImplementation(async () => {
    throw new Error('response lost')
  })
  await expect(
    disableSigner(f.env, f.client, {
      ...f.input,
      userAccessToken: 'owner-token',
    }),
  ).rejects.toThrow('outcome is unknown')
  await expect(prepareSigner(f.env, f.client, f.input)).rejects.toThrow(
    'needs verification',
  )
  await expect(confirmSigner(f.env, f.client, f.input)).rejects.toThrow(
    'current embedded wallet',
  )
  await expect(
    disableSigner(f.env, f.client, {
      ...f.input,
      userAccessToken: 'owner-token',
    }),
  ).rejects.toThrow('needs verification')
  const row = await drizzle(db)
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, f.input.userId))
    .get()
  expect(row?.status).toBe('disabled')
  expect(row?.policyId).toBe(policyId)
  expect(f.create).toHaveBeenCalledTimes(1)
  expect(f.update).toHaveBeenCalledTimes(1)
})

test('a removal guard acquired during provider checks prevents confirmation or policy release', async () => {
  const confirming = fixture()
  await prepareSigner(confirming.env, confirming.client, confirming.input)
  confirming.attach()
  const guard = async (f: ReturnType<typeof fixture>) => {
    await drizzle(db)
      .insert(walletSignerRemoval)
      .values({
        walletId: f.walletId,
        privyUserId: f.input.userId,
        signerId: 'payments',
        token: crypto.randomUUID(),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
  }
  confirming.onGet(() => guard(confirming))
  await expect(
    confirmSigner(confirming.env, confirming.client, confirming.input),
  ).rejects.toThrow('disabled or replaced')
  expect(
    (await signerStatus(confirming.env, confirming.input.userId)).status,
  ).toBe('pending')
  const preparing = fixture()
  preparing.onCreate(() => guard(preparing))
  await expect(
    prepareSigner(preparing.env, preparing.client, preparing.input),
  ).rejects.toThrow('disabled or replaced')
  const row = await drizzle(db)
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, preparing.input.userId))
    .get()
  expect(row?.policyId.startsWith('preparing:')).toBe(true)
})

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }))
const { createTransactionSignerRoutes } =
  await import('../routes/transaction-signer')

test('authenticated owner setup integrates with automatic execution, uncertain submission recovery and selective removal', async () => {
  const f = fixture()
  const identity = {
    userId: f.input.userId,
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    status: 'active',
    outgoingAllowed: false,
    createdAt: Date.now(),
  })
  await drizzle(db).insert(paymentSigner).values({
    privyUserId: identity.userId,
    walletId: f.walletId,
    walletAddress: ADDRESS,
    policyId: 'payment-policy',
    status: 'enabled',
    updatedAt: 1,
  })
  const app = createTransactionSignerRoutes(
    async (c, next) => {
      c.set('userId', identity.userId)
      await next()
    },
    () => f.client,
  )
  const routeEnv = { ...f.env }
  const call = (operation: string) =>
    app.request(
      '/' + operation,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer mock-owner-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ walletAddress: ADDRESS }),
      },
      routeEnv,
    )
  const prepared = await call('prepare')
  expect(prepared.status).toBe(200)
  const preparedPayload: unknown = await prepared.json()
  expect(preparedPayload).toEqual({
    signerId: 'transactions',
    policyIds: [f.policy().id],
  })
  expect((await call('confirm')).status).toBe(409)
  f.attach() // Fake owner addSigners callback; no Privy request.
  expect((await call('confirm')).status).toBe(200)
  let signedBase64 = ''
  const signTransaction = mock(
    async (_walletId: string, body: { transaction: string }) => {
      const bytes = new Uint8Array(getBase64Encoder().encode(body.transaction))
      bytes.fill(1, 1, 65) // Non-cryptographic fixture, never a real wallet signature.
      signedBase64 = getBase64Decoder().decode(bytes)
      return { signed_transaction: signedBase64 }
    },
  )
  const client = {
    wallets: () => ({
      ...f.client.wallets(),
      solana: () => ({ signTransaction }),
    }),
  } as unknown as Pick<PrivyClient, 'wallets'>
  let observed = false
  const send = mock(async (_wire: string) => {
    throw new Error('Mock RPC response loss')
  })
  const deps = {
    authority: (env: EmbeddedSolEnv, userId: string) =>
      resolveEmbeddedAuthority(env, userId, client),
    prepare: async () => ({
      genesisHash: PAYMENT_NETWORKS.devnet.genesisHash,
      slot: 42n,
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100n,
    }),
    verify: (
      wire: string,
      expected: Parameters<typeof verifySignedSolTransfer>[1],
    ) => verifySignedSolTransfer(wire, expected, async () => true),
    rpc: async () => ({
      blockHeight: async () => 50n,
      send,
      status: async () =>
        observed
          ? {
              signedBase64,
              slot: '45',
              commitment: 'confirmed' as const,
              failed: false,
            }
          : null,
    }),
  }
  const input = {
    idempotencyKey: 'owner-integrated',
    recipient: OTHER,
    amountLamports: '1001',
  }
  expect((await executeEmbeddedSol(f.env, identity, input, deps)).ok).toBe(
    false,
  )
  expect(signTransaction).not.toHaveBeenCalled()
  await drizzle(db)
    .update(mcpGrant)
    .set({ outgoingAllowed: true })
    .where(eq(mcpGrant.id, identity.grantId))
  const result = await executeEmbeddedSol(f.env, identity, input, deps)
  if (!result.ok) throw new Error(result.reason)
  expect(result.result.state).toBe('uncertain')
  expect(result.result.signature).toBe(
    getSignatureFromTransaction(
      getTransactionDecoder().decode(getBase64Encoder().encode(signedBase64)),
    ),
  )
  await executeEmbeddedSol(f.env, identity, input, deps)
  expect(signTransaction).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
  observed = true
  expect(
    (await getTransferStatus(f.env, identity, result.result.requestId, deps))
      .state,
  ).toBe('succeeded')
  expect((await call('disable')).status).toBe(200)
  expect(f.wallet().additional_signers).toEqual([
    { signer_id: 'payments', override_policy_ids: ['payment-policy'] },
  ])
  expect(
    (
      await drizzle(db)
        .select()
        .from(paymentSigner)
        .where(eq(paymentSigner.privyUserId, identity.userId))
        .get()
    )?.status,
  ).toBe('enabled')
  expect(
    (
      await executeEmbeddedSol(
        f.env,
        identity,
        { ...input, idempotencyKey: 'after-disable' },
        deps,
      )
    ).ok,
  ).toBe(false)
  expect(signTransaction).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenCalledTimes(1)
})

test('owner routes reject signed-out, malformed and caller-controlled authority before provider calls', async () => {
  const f = fixture()
  const unauthenticated = createTransactionSignerRoutes(undefined, () => {
    throw new Error('Provider must not be reached')
  })
  expect((await unauthenticated.request('/', {}, { ...f.env })).status).toBe(
    401,
  )
  const app = createTransactionSignerRoutes(
    async (c, next) => {
      c.set('userId', f.input.userId)
      await next()
    },
    () => f.client,
  )
  for (const body of [
    '{',
    JSON.stringify({ walletAddress: ADDRESS, signerId: 'caller-controlled' }),
  ])
    expect(
      (
        await app.request(
          '/prepare',
          { method: 'POST', body },
          {
            ...f.env,
          },
        )
      ).status,
    ).toBe(400)
  expect(
    (await app.request('/other', { method: 'POST' }, { ...f.env })).status,
  ).toBe(404)
  expect(f.create).not.toHaveBeenCalled()
})
