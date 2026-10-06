import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import {
  getBase64Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit'
import type { D1Database } from '@cloudflare/workers-types'
import type { PrivyClient } from '@privy-io/node'
import {
  mcpGrant,
  transactionSigner,
  transactionRequest,
  transactionAttempt,
} from '../db/schema'
import { testDatabase } from '../test-database'
import { PAYMENT_NETWORKS } from '../solana/network'
import {
  executeEmbeddedSol,
  getTransferStatus,
  resolveEmbeddedAuthority,
} from './embedded-sol'
import type { EmbeddedSolDependencies, EmbeddedSolEnv } from './embedded-sol'
import { getLatestAttempt } from './ledger'
import { unsignedSolWire, verifySignedSolTransfer } from './sol-execution'
import { buildSolTransferMessage } from './sol-transfer'

const wallet = 'So11111111111111111111111111111111111111112'
const recipient = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const input = {
  idempotencyKey: 'automatic',
  recipient,
  amountLamports: '1000001',
}

test('production authority boundary checks owner wallet and exact signer policy, then invokes sign-only with transaction key', async () => {
  const f = await fixture()
  const row = await drizzle(db)
    .select()
    .from(transactionSigner)
    .where(eq(transactionSigner.privyUserId, f.identity.userId))
    .get()
  if (!row) throw new Error('Missing test delegation')
  let owned = true
  let policies = [row.policyId]
  const signTransaction = mock(async () => ({
    signed_transaction: 'mock-signed-wire',
  }))
  const list = mock((query: unknown) =>
    (async function* () {
      expect(query).toEqual({
        user_id: f.identity.userId,
        chain_type: 'solana',
      })
      yield {
        id: owned ? row.walletId : 'another-wallet',
        address: row.walletAddress,
      }
    })(),
  )
  const client = {
    wallets: () => ({
      list,
      get: async () => ({
        address: row.walletAddress,
        additional_signers: [
          { signer_id: row.signerId, override_policy_ids: policies },
        ],
      }),
      solana: () => ({ signTransaction }),
    }),
  } as unknown as PrivyClient
  owned = false
  await expect(
    resolveEmbeddedAuthority(f.env, f.identity.userId, client),
  ).rejects.toThrow('verify separate')
  owned = true
  for (const value of [[], ['other-policy'], [row.policyId, 'broad-policy']]) {
    policies = value
    await expect(
      resolveEmbeddedAuthority(f.env, f.identity.userId, client),
    ).rejects.toThrow('verify separate')
  }
  policies = [row.policyId]
  const authority = await resolveEmbeddedAuthority(
    f.env,
    f.identity.userId,
    client,
  )
  const message = getBase64Decoder().decode(
    buildSolTransferMessage({
      walletAddress: wallet,
      recipient,
      amountLamports: input.amountLamports,
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100n,
    }),
  )
  expect(await authority.sign(message)).toBe('mock-signed-wire')
  expect(signTransaction).toHaveBeenCalledWith(row.walletId, {
    transaction: unsignedSolWire(message),
    authorization_context: {
      authorization_private_keys: [f.env.PRIVY_TRANSACTION_SIGNER_KEY],
    },
  })
  expect(signTransaction).toHaveBeenCalledTimes(1)
  await drizzle(db)
    .update(transactionSigner)
    .set({ status: 'disabled' })
    .where(eq(transactionSigner.privyUserId, f.identity.userId))
  await expect(
    resolveEmbeddedAuthority(f.env, f.identity.userId, client),
  ).rejects.toThrow('Set up separate')
})
let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 30000)
afterAll(async () => {
  await dispose()
})
async function fixture() {
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    status: 'active',
    outgoingAllowed: true,
    createdAt: Date.now(),
  })
  const walletId = crypto.randomUUID()
  await drizzle(db).insert(transactionSigner).values({
    privyUserId: identity.userId,
    walletId,
    walletAddress: wallet,
    signerId: 'transactions-only',
    policyId: 'sol-policy',
    status: 'enabled',
    updatedAt: Date.now(),
  })
  const env = {
    DB: db,
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: 'https://rpc.invalid/key',
    PRIVY_APP_ID: 'mock',
    PRIVY_APP_SECRET: 'mock',
    PRIVY_PAYMENT_SIGNER_ID: 'payment',
    PRIVY_PAYMENT_SIGNER_KEY: 'payment-key',
    SOL_TRANSACTION_SIGNING_ENABLED: 'true',
    PRIVY_TRANSACTION_SIGNER_ID: 'transactions-only',
    PRIVY_TRANSACTION_SIGNER_KEY: 'transaction-key',
  }
  let signs = 0,
    sends = 0,
    authorities = 0
  let signingFailure = false,
    sendFailure = false,
    height = 50n
  let mutateMessage = false
  let signedWire = ''
  let chain: {
    signedBase64: string
    slot: string
    commitment: 'confirmed' | 'finalized'
    failed: boolean
  } | null = null
  let beforePreparation: () => Promise<void> = async () => {}
  const deps: EmbeddedSolDependencies = {
    prepare: async () => {
      await beforePreparation()
      return {
        genesisHash: PAYMENT_NETWORKS.devnet.genesisHash,
        slot: 42n,
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 100n,
      }
    },
    authority: async () => {
      authorities++
      return {
        walletId,
        walletAddress: wallet,
        signerId: 'transactions-only',
        sign: async (message) => {
          signs++
          if (signingFailure) throw new Error('mock sign response loss')
          const bytes = new Uint8Array(
            getBase64Encoder().encode(unsignedSolWire(message)),
          )
          // Deterministic non-cryptographic fixture. This test never signs.
          bytes.fill(1, 1, 65)
          if (mutateMessage)
            bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 1
          signedWire = getBase64Decoder().decode(bytes)
          return signedWire
        },
      }
    },
    verify: (wire, expected) =>
      verifySignedSolTransfer(wire, expected, async () => true),
    rpc: async () => ({
      blockHeight: async () => height,
      send: async (wire) => {
        sends++
        if (sendFailure) throw new Error('mock response loss')
        return getSignatureFromTransaction(
          getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
        )
      },
      status: async () => chain,
    }),
  }
  return {
    identity,
    env,
    deps,
    signs: () => signs,
    sends: () => sends,
    authorities: () => authorities,
    signedWire: () => signedWire,
    setSigningFailure: () => (signingFailure = true),
    setSendFailure: () => (sendFailure = true),
    setMutate: () => (mutateMessage = true),
    setHeight: (n: bigint) => (height = n),
    setChain: (value: typeof chain) => (chain = value),
    beforePreparation: (value: typeof beforePreparation) =>
      (beforePreparation = value),
  }
}

test('default-off or payment authority reuse refuses before request/sign/network work', async () => {
  const f = await fixture()
  const defaultEnv: EmbeddedSolEnv = { ...f.env }
  delete defaultEnv.SOL_TRANSACTION_SIGNING_ENABLED
  for (const env of [
    defaultEnv,
    { ...f.env, PRIVY_TRANSACTION_SIGNER_ID: 'payment' },
    { ...f.env, PRIVY_TRANSACTION_SIGNER_KEY: 'payment-key' },
    { ...f.env, SOLANA_NETWORK: 'mainnet' },
  ]) {
    const result = await executeEmbeddedSol(env, f.identity, input, f.deps)
    expect(result.ok).toBe(false)
  }
  expect(f.authorities()).toBe(0)
  expect(f.signs()).toBe(0)
  expect(f.sends()).toBe(0)
  const rows = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.privyUserId, f.identity.userId))
  expect(rows).toHaveLength(0)
})

test('one automatic sign and send under duplicate calls, with exact durable signed wire and safe result', async () => {
  const f = await fixture()
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      executeEmbeddedSol(f.env, f.identity, input, f.deps),
    ),
  )
  expect(f.signs()).toBe(1)
  expect(f.sends()).toBe(1)
  const result = await executeEmbeddedSol(f.env, f.identity, input, f.deps)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('Expected success')
  expect(result.result.state).toBe('submitted')
  expect(result.result).not.toHaveProperty('messageBase64')
  expect(result.result).not.toHaveProperty('claimToken')
  expect(results.every((entry) => entry.ok)).toBe(true)
  const attempt = await getLatestAttempt(
    db,
    f.identity,
    result.result.requestId,
  )
  expect(attempt?.signedBase64).toBe(f.signedWire())
  expect(f.signs()).toBe(1)
  expect(f.sends()).toBe(1)
  f.setChain({
    signedBase64: f.signedWire(),
    slot: '48',
    commitment: 'confirmed',
    failed: false,
  })
  expect(
    (
      await getTransferStatus(
        f.env,
        f.identity,
        result.result.requestId,
        f.deps,
      )
    ).state,
  ).toBe('succeeded')
})

test('permission or delegation disabled before signing claim means no sign or send', async () => {
  for (const permission of [true, false]) {
    const f = await fixture()
    f.beforePreparation(async () => {
      if (permission)
        await drizzle(db)
          .update(mcpGrant)
          .set({ outgoingAllowed: false })
          .where(eq(mcpGrant.id, f.identity.grantId))
      else
        await drizzle(db)
          .update(transactionSigner)
          .set({ status: 'disabled' })
          .where(eq(transactionSigner.privyUserId, f.identity.userId))
    })
    await executeEmbeddedSol(f.env, f.identity, input, f.deps)
    expect(f.signs()).toBe(0)
    expect(f.sends()).toBe(0)
  }
})

test('initial owner permission and active exact identity are required', async () => {
  const f = await fixture()
  await drizzle(db)
    .update(mcpGrant)
    .set({ outgoingAllowed: false })
    .where(eq(mcpGrant.id, f.identity.grantId))
  expect((await executeEmbeddedSol(f.env, f.identity, input, f.deps)).ok).toBe(
    false,
  )
  expect(
    (
      await executeEmbeddedSol(
        f.env,
        { ...f.identity, userId: 'other' },
        input,
        f.deps,
      )
    ).ok,
  ).toBe(false)
  expect(
    (
      await executeEmbeddedSol(
        f.env,
        f.identity,
        { ...input, walletId: 'caller-controlled' },
        f.deps,
      )
    ).ok,
  ).toBe(false)
  expect(f.authorities()).toBe(0)
})

test('sign response loss remains uncertain and never triggers another sign or submission', async () => {
  const f = await fixture()
  f.setSigningFailure()
  const result = await executeEmbeddedSol(f.env, f.identity, input, f.deps)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('Expected durable progress')
  expect(result.result.state).toBe('uncertain')
  await executeEmbeddedSol(f.env, f.identity, input, f.deps)
  expect(f.signs()).toBe(1)
  expect(f.sends()).toBe(0)
  expect(
    (await getLatestAttempt(db, f.identity, result.result.requestId))
      ?.signedBase64,
  ).toBeNull()
})

test('changed signed message or default invalid signature never reaches submission', async () => {
  for (const mutate of [true, false]) {
    const f = await fixture()
    if (mutate) f.setMutate()
    const result = await executeEmbeddedSol(
      f.env,
      f.identity,
      input,
      mutate ? f.deps : { ...f.deps, verify: verifySignedSolTransfer },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected durable progress')
    expect(result.result.state).toBe('uncertain')
    expect(f.sends()).toBe(0)
    expect(
      (await getLatestAttempt(db, f.identity, result.result.requestId))
        ?.signedBase64,
    ).toBeNull()
  }
})

test('a changed persisted message is refused before the sign-only boundary', async () => {
  const f = await fixture()
  const createRpc = f.deps.rpc
  if (!createRpc) throw new Error('Missing mock RPC')
  const deps: EmbeddedSolDependencies = {
    ...f.deps,
    rpc: async (env) => {
      const rpc = await createRpc(env)
      return {
        ...rpc,
        blockHeight: async () => {
          const height = await rpc.blockHeight()
          const request = await drizzle(db)
            .select()
            .from(transactionRequest)
            .where(eq(transactionRequest.privyUserId, f.identity.userId))
            .get()
          if (request) {
            const attempt = await getLatestAttempt(db, f.identity, request.id)
            if (attempt?.state === 'prepared' && attempt.messageBase64) {
              const bytes = new Uint8Array(
                getBase64Encoder().encode(attempt.messageBase64),
              )
              bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1
              await drizzle(db)
                .update(transactionAttempt)
                .set({ messageBase64: getBase64Decoder().decode(bytes) })
                .where(eq(transactionAttempt.id, attempt.id))
            }
          }
          return height
        },
      }
    },
  }
  await executeEmbeddedSol(f.env, f.identity, input, deps)
  expect(f.signs()).toBe(0)
  expect(f.sends()).toBe(0)
})

test('submission timeout preserves exact wire, status is client owned, and expired blockhash never triggers replacement', async () => {
  const f = await fixture()
  f.setSendFailure()
  const result = await executeEmbeddedSol(f.env, f.identity, input, f.deps)
  if (!result.ok) throw new Error('Expected durable progress')
  expect(result.result.state).toBe('uncertain')
  f.setHeight(101n)
  await executeEmbeddedSol(f.env, f.identity, input, f.deps)
  expect(f.signs()).toBe(1)
  expect(f.sends()).toBe(1)
  await expect(
    getTransferStatus(
      f.env,
      { ...f.identity, clientId: 'other' },
      result.result.requestId,
      f.deps,
    ),
  ).rejects.toThrow('unavailable')
  f.setChain({
    signedBase64: f.signedWire(),
    slot: '48',
    commitment: 'finalized',
    failed: true,
  })
  expect(
    (
      await getTransferStatus(
        f.env,
        f.identity,
        result.result.requestId,
        f.deps,
      )
    ).state,
  ).toBe('failed')
})
