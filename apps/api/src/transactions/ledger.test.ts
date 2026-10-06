import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type { D1Database } from '@cloudflare/workers-types'
import type { PreparedTransaction } from '@lanatools/contracts'
import { mcpGrant, transactionAttempt, transactionRequest } from '../db/schema'
import { testDatabase } from '../test-database'
import { normalizeInput } from './input'
import {
  abandonPreparation,
  claimPreparation,
  claimSigning,
  claimSubmission,
  createRequest,
  getRequest,
  getLatestAttempt,
  issueAttempt,
  recordOutcome,
  refuseRequest,
  selectExternalWallet,
  storePrepared,
  storeVerifiedSigned,
} from './ledger'

const WALLET = '11111111111111111111111111111111'
const OTHER = 'So11111111111111111111111111111111111111112'
const context = {
  network: 'devnet',
  embeddedWallet: { id: 'owner-wallet', address: WALLET },
} as const
const intent = {
  action: 'transfer_sol',
  execution: 'embedded',
  idempotencyKey: 'first',
  recipient: OTHER,
  amountLamports: '1000000',
} as const
const external = {
  action: 'transfer_sol',
  execution: 'external',
  idempotencyKey: 'external',
  recipient: OTHER,
  amountLamports: '1000000',
  externalWallet: null,
} as const

function fixture(wallet = WALLET, height = 100n) {
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(address(wallet), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash(WALLET), lastValidBlockHeight: height },
          message,
        ),
    ),
  )
  // Deterministic non-cryptographic bytes. These tests never sign or broadcast.
  const wire = new Uint8Array(65 + transaction.messageBytes.length)
  wire[0] = 1
  wire.fill(1, 1, 65)
  wire.set(transaction.messageBytes, 65)
  const signedBase64 = getBase64Decoder().decode(wire)
  const signature = getSignatureFromTransaction(
    getTransactionDecoder().decode(wire),
  )
  const prepared: PreparedTransaction = {
    walletAddress: wallet,
    network: 'devnet',
    messageBase64: getBase64Decoder().decode(transaction.messageBytes),
    preparationSlot: '50',
    blockhash: WALLET,
    lastValidBlockHeight: height.toString(),
  }
  return { prepared, signed: { signedBase64, signature } }
}

async function connect(
  database: D1Database = db,
  userId = crypto.randomUUID(),
) {
  const identity = {
    userId,
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(database).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: userId,
    clientId: identity.clientId,
    status: 'active',
    createdAt: Date.now(),
  })
  return identity
}

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

async function preparedAttempt(input: unknown = intent) {
  const identity = await connect()
  const request = await createRequest(db, identity, input, context)
  const claim = await claimPreparation(db, identity, request.requestId)
  if (!claim) throw new Error('Expected preparation claim')
  await storePrepared(db, identity, claim, fixture().prepared)
  return { identity, request, claim }
}

test('equal concurrent requests have one ID, normalized amounts and safe results', async () => {
  const identity = await connect()
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      createRequest(db, identity, intent, context),
    ),
  )
  expect(new Set(results.map((r) => r.requestId)).size).toBe(1)
  const first = results[0]
  if (!first) throw new Error('Expected a request')
  expect(
    await createRequest(
      db,
      identity,
      { ...intent, amountLamports: '0001000000' },
      context,
    ),
  ).toEqual(first)
  expect(Object.keys(results[0] ?? {}).sort()).toEqual([
    'attemptId',
    'reason',
    'requestId',
    'signature',
    'state',
  ])
})

test('changed intent conflicts, including wallet identity and network', async () => {
  const identity = await connect()
  await createRequest(db, identity, intent, context)
  for (const input of [
    { ...intent, recipient: WALLET },
    { ...intent, amountLamports: '2' },
    { ...external, idempotencyKey: intent.idempotencyKey },
  ])
    await expect(createRequest(db, identity, input, context)).rejects.toThrow(
      'different transaction',
    )
  await expect(
    createRequest(db, identity, intent, { ...context, network: 'mainnet' }),
  ).rejects.toThrow('different transaction')
  await expect(
    createRequest(db, identity, intent, {
      ...context,
      embeddedWallet: { id: 'new-wallet', address: OTHER },
    }),
  ).rejects.toThrow('different transaction')
})

test('keys and reads are isolated by authenticated user and client', async () => {
  const a = await connect(),
    b = await connect(db, a.userId),
    c = await connect()
  const ra = await createRequest(db, a, intent, context)
  const rb = await createRequest(db, b, intent, context)
  const rc = await createRequest(db, c, intent, context)
  expect(new Set([ra.requestId, rb.requestId, rc.requestId]).size).toBe(3)
  await expect(getRequest(db, b, ra.requestId)).rejects.toThrow('unavailable')
  for (const field of ['userId', 'clientId', 'grantId'])
    await expect(
      createRequest(db, { ...a, [field]: 'forged' }, intent, context),
    ).rejects.toThrow('unavailable')
})

test('revocation blocks access; reconnect recovers history with the new grant', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'revoked' })
    .where(eq(mcpGrant.id, identity.grantId))
  await expect(getRequest(db, identity, request.requestId)).rejects.toThrow(
    'unavailable',
  )
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
  const renewed = { ...identity, grantId: crypto.randomUUID() }
  await drizzle(db)
    .update(mcpGrant)
    .set({ id: renewed.grantId, status: 'active' })
    .where(eq(mcpGrant.id, identity.grantId))
  expect(await createRequest(db, renewed, intent, context)).toEqual(request)
  const row = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, request.requestId))
    .get()
  expect(row?.originatingGrantId).toBe(identity.grantId)
})

test('strict named input rejects amount errors, overrides and implicit signing', async () => {
  const identity = await connect()
  for (const amountLamports of [
    '0',
    '-1',
    '1.1',
    '1e6',
    '18446744073709551616',
    '',
  ])
    await expect(
      createRequest(db, identity, { ...intent, amountLamports }, context),
    ).rejects.toThrow()
  for (const input of [
    { ...intent, walletId: 'agent-choice' },
    { ...intent, externalWallet: OTHER },
    { ...intent, execution: undefined },
    { ...intent, recipient: 'bad' },
    { ...intent, idempotencyKey: '' },
  ])
    await expect(createRequest(db, identity, input, context)).rejects.toThrow()
  await expect(
    createRequest(db, identity, intent, { ...context, embeddedWallet: null }),
  ).rejects.toThrow()
})

test('embedded wallet property order cannot change canonical identity', async () => {
  const first = await normalizeInput(intent, context)
  const second = await normalizeInput(intent, {
    ...context,
    embeddedWallet: { address: WALLET, id: 'owner-wallet' },
  })
  expect(first).toEqual(second)
})

test('unknown external wallet binds once and does not change idempotency input', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, external, context)
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
  await selectExternalWallet(db, identity, request.requestId, WALLET)
  await selectExternalWallet(db, identity, request.requestId, WALLET)
  await expect(
    selectExternalWallet(db, identity, request.requestId, OTHER),
  ).rejects.toThrow('does not match')
  expect(await createRequest(db, identity, external, context)).toEqual(request)
  expect(await claimPreparation(db, identity, request.requestId)).not.toBeNull()
  await expect(
    createRequest(
      db,
      identity,
      { ...external, externalWallet: WALLET },
      context,
    ),
  ).rejects.toThrow('different transaction')
})

test('a declared external address cannot be replaced and selection races have one winner', async () => {
  const identity = await connect()
  const declared = await createRequest(
    db,
    identity,
    { ...external, externalWallet: OTHER },
    context,
  )
  await expect(
    selectExternalWallet(db, identity, declared.requestId, WALLET),
  ).rejects.toThrow()
  const request = await createRequest(
    db,
    identity,
    { ...external, idempotencyKey: 'race' },
    context,
  )
  const results = await Promise.allSettled(
    [WALLET, OTHER].map((wallet) =>
      selectExternalWallet(db, identity, request.requestId, wallet),
    ),
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
})

test('authenticated refusals persist and cannot replace an active attempt', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  const refused = await refuseRequest(
    db,
    identity,
    request.requestId,
    'outgoing_not_allowed',
  )
  expect(refused.state).toBe('refused')
  expect(await createRequest(db, identity, intent, context)).toEqual(refused)
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
  const active = await preparedAttempt()
  await expect(
    refuseRequest(db, active.identity, active.request.requestId, 'denied'),
  ).rejects.toThrow()
})

test('concurrent preparations claim one attempt; abandonment allows the next number', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  const claims = await Promise.all(
    Array.from({ length: 12 }, () =>
      claimPreparation(db, identity, request.requestId),
    ),
  )
  const winners = claims.filter((c) => c !== null)
  expect(winners).toHaveLength(1)
  const first = winners[0]
  if (!first) throw new Error('Expected winner')
  await expect(
    abandonPreparation(db, identity, { ...first, token: 'stale' }),
  ).rejects.toThrow()
  await abandonPreparation(db, identity, first)
  const second = await claimPreparation(db, identity, request.requestId)
  const attempts = await drizzle(db)
    .select()
    .from(transactionAttempt)
    .where(eq(transactionAttempt.requestId, request.requestId))
  expect(attempts.map((a) => a.number).sort()).toEqual([1, 2])
  expect(second).not.toBeNull()
})

test('prepared wallet/network/lifetime must match and prepared bytes cannot change', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  const claim = await claimPreparation(db, identity, request.requestId)
  if (!claim) throw new Error('Expected claim')
  const { prepared } = fixture()
  for (const data of [
    { ...prepared, walletAddress: OTHER },
    { ...prepared, network: 'mainnet' } as const,
    { ...prepared, preparationSlot: '-1' },
    { ...prepared, blockhash: 'bad' },
    { ...prepared, blockhash: OTHER },
    { ...prepared, messageBase64: fixture(OTHER).prepared.messageBase64 },
    { ...prepared, messageBase64: '' },
  ])
    await expect(storePrepared(db, identity, claim, data)).rejects.toThrow()
  await storePrepared(db, identity, claim, prepared)
  await expect(
    storePrepared(db, identity, claim, fixture(OTHER).prepared),
  ).rejects.toThrow()
  await expect(abandonPreparation(db, identity, claim)).rejects.toThrow()
  expect(
    await claimPreparation(
      db,
      identity,
      request.requestId,
      Date.now() + 1_000_000,
    ),
  ).toBeNull()
})

test('embedded signing has one permit and cannot use the external issuance path', async () => {
  const { identity, request, claim } = await preparedAttempt()
  await expect(issueAttempt(db, identity, claim)).rejects.toThrow()
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => claimSigning(db, identity, claim)),
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'signing',
  )
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
})

test('external bytes are exposed only after the issued marker is durable', async () => {
  const { identity, request, claim } = await preparedAttempt({
    ...external,
    externalWallet: WALLET,
  })
  await expect(claimSigning(db, identity, claim)).rejects.toThrow()
  expect(await issueAttempt(db, identity, claim)).toBe(
    fixture().prepared.messageBase64,
  )
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'issued',
  )
  await expect(issueAttempt(db, identity, claim)).rejects.toThrow()
})

test('signed registration preserves the exact prepared message and signature', async () => {
  const { identity, request, claim } = await preparedAttempt()
  const signing = await claimSigning(db, identity, claim)
  await expect(
    storeVerifiedSigned(db, identity, signing, fixture(OTHER).signed),
  ).rejects.toThrow()
  await expect(
    storeVerifiedSigned(db, identity, signing, {
      ...fixture().signed,
      signature: 'wrong',
    }),
  ).rejects.toThrow()
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'signing',
  )
  await storeVerifiedSigned(db, identity, signing, fixture().signed)
  await storeVerifiedSigned(db, identity, signing, fixture().signed)
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'signed',
  )
  const submissions = await Promise.allSettled(
    Array.from({ length: 8 }, () => claimSubmission(db, identity, signing)),
  )
  expect(submissions.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
})

test('RPC acceptance, uncertainty and confirmed success are distinct and terminal', async () => {
  const { identity, request, claim } = await preparedAttempt()
  const signing = await claimSigning(db, identity, claim)
  await storeVerifiedSigned(db, identity, signing, fixture().signed)
  const submission = await claimSubmission(db, identity, signing)
  expect(submission.signedBase64).toBe(fixture().signed.signedBase64)
  await recordOutcome(db, identity, submission, {
    kind: 'transport_unknown',
    reason: 'timeout',
  })
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'uncertain',
  )
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
  await expect(
    recordOutcome(db, identity, submission, {
      kind: 'chain_success',
      signature: 'wrong',
      slot: '75',
      commitment: 'confirmed',
      reason: null,
    }),
  ).rejects.toThrow()
  await recordOutcome(db, identity, submission, {
    kind: 'chain_success',
    signature: fixture().signed.signature,
    slot: '75',
    commitment: 'confirmed',
    reason: null,
  })
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'succeeded',
  )
  await recordOutcome(db, identity, submission, {
    kind: 'chain_success',
    signature: fixture().signed.signature,
    slot: '75',
    commitment: 'finalized',
    reason: null,
  })
  expect(
    (await getLatestAttempt(db, identity, request.requestId))?.evidence,
  ).toContain('finalized')
  await expect(
    recordOutcome(db, identity, submission, {
      kind: 'chain_success',
      signature: fixture().signed.signature,
      slot: '75',
      commitment: 'confirmed',
      reason: null,
    }),
  ).rejects.toThrow()
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
  await expect(
    recordOutcome(db, identity, submission, {
      kind: 'transport_unknown',
      reason: 'late',
    }),
  ).rejects.toThrow()
})

test('RPC acceptance alone reports submitted and expiry needs reconciled history', async () => {
  const { identity, request, claim } = await preparedAttempt()
  const signing = await claimSigning(db, identity, claim)
  await storeVerifiedSigned(db, identity, signing, fixture().signed)
  const submission = await claimSubmission(db, identity, signing)
  await recordOutcome(db, identity, submission, {
    kind: 'rpc_accepted',
    signature: fixture().signed.signature,
  })
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'submitted',
  )
  await expect(
    recordOutcome(db, identity, submission, {
      kind: 'expiry_reconciled',
      checkedBlockHeight: '100',
      historyChecked: true,
    }),
  ).rejects.toThrow('not expired')
  await recordOutcome(db, identity, submission, {
    kind: 'expiry_reconciled',
    checkedBlockHeight: '101',
    historyChecked: true,
  })
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'expired',
  )
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
})

test('the migration enforces one active attempt and required prepared fields directly', async () => {
  const { request, claim } = await preparedAttempt()
  await expect(
    drizzle(db)
      .insert(transactionAttempt)
      .values({
        id: crypto.randomUUID(),
        requestId: request.requestId,
        number: 2,
        state: 'preparing',
        claimToken: 'raw',
        walletAddress: WALLET,
        network: 'devnet',
        createdAt: 1,
        updatedAt: 1,
      })
      .run(),
  ).rejects.toThrow()
  await expect(
    drizzle(db)
      .update(transactionAttempt)
      .set({ messageHash: null })
      .where(eq(transactionAttempt.id, claim.attemptId))
      .run(),
  ).rejects.toThrow()
})

function failingWrites(database: D1Database) {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare')
        return (query: string) => {
          if (/^\s*(insert|update)/i.test(query))
            throw new Error('injected durable write failure')
          return target.prepare(query)
        }
      return Reflect.get(target, property)
    },
  })
}

test('failed creation and required writes never authorize downstream calls', async () => {
  const { identity, request, claim } = await preparedAttempt()
  const failing = failingWrites(db)
  await expect(
    createRequest(
      failing,
      identity,
      { ...intent, idempotencyKey: 'fail' },
      context,
    ),
  ).rejects.toThrow()
  const sign = mock(() => {})
  await expect(
    (async () => {
      await claimSigning(failing, identity, claim)
      sign()
    })(),
  ).rejects.toThrow()
  expect(sign).not.toHaveBeenCalled()
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'prepared',
  )
  const signing = await claimSigning(db, identity, claim)
  await expect(
    storeVerifiedSigned(failing, identity, signing, fixture().signed),
  ).rejects.toThrow()
  await storeVerifiedSigned(db, identity, signing, fixture().signed)
  const submit = mock(() => {})
  await expect(
    (async () => {
      await claimSubmission(failing, identity, signing)
      submit()
    })(),
  ).rejects.toThrow()
  expect(submit).not.toHaveBeenCalled()
})

test('process restart recovers immutable bytes and blocks a second signing claim', async () => {
  const path = await mkdtemp(join(tmpdir(), 'lanatools-transactions-'))
  let opened: Awaited<ReturnType<typeof testDatabase>> | undefined
  try {
    opened = await testDatabase({ persist: path, migrate: true })
    const identity = await connect(opened.db)
    const request = await createRequest(opened.db, identity, intent, context)
    const claim = await claimPreparation(opened.db, identity, request.requestId)
    if (!claim) throw new Error('Expected claim')
    await storePrepared(opened.db, identity, claim, fixture().prepared)
    const signing = await claimSigning(opened.db, identity, claim)
    await storeVerifiedSigned(opened.db, identity, signing, fixture().signed)
    const submission = await claimSubmission(opened.db, identity, signing)
    await opened.dispose()
    opened = undefined
    opened = await testDatabase({ persist: path, migrate: false })
    expect(
      (await createRequest(opened.db, identity, intent, context)).state,
    ).toBe('submitting')
    await expect(
      claimSubmission(opened.db, identity, signing),
    ).rejects.toThrow()
    expect(
      await claimPreparation(opened.db, identity, request.requestId),
    ).toBeNull()
    const row = await getLatestAttempt(opened.db, identity, request.requestId)
    expect(row?.signedBase64).toBe(fixture().signed.signedBase64)
    expect(row?.messageBase64).toBe(fixture().prepared.messageBase64)
    expect(row?.claimToken).toBe(submission.token)
  } finally {
    await opened?.dispose()
    await rm(path, { recursive: true, force: true })
  }
}, 60_000)

test('failed preparation storage and external issuance release no bytes', async () => {
  const identity = await connect()
  const request = await createRequest(
    db,
    identity,
    { ...external, externalWallet: WALLET },
    context,
  )
  const claim = await claimPreparation(db, identity, request.requestId)
  if (!claim) throw new Error('Expected claim')
  const failing = failingWrites(db)
  const release = mock((_bytes?: string | null) => {})
  await expect(
    (async () => {
      await storePrepared(failing, identity, claim, fixture().prepared)
      release()
    })(),
  ).rejects.toThrow()
  expect(release).not.toHaveBeenCalled()
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'preparing',
  )
  await storePrepared(db, identity, claim, fixture().prepared)
  await expect(
    (async () => {
      const bytes = await issueAttempt(failing, identity, claim)
      release(bytes)
    })(),
  ).rejects.toThrow()
  expect(release).not.toHaveBeenCalled()
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'prepared',
  )
})

test('a committed claim with a lost response cannot issue a second permit', async () => {
  const { identity, request, claim } = await preparedAttempt()
  const lostResponse = async () => {
    await claimSigning(db, identity, claim)
    throw new Error('response lost after commit')
  }
  await expect(lostResponse()).rejects.toThrow('response lost')
  await expect(claimSigning(db, identity, claim)).rejects.toThrow()
  expect(await claimPreparation(db, identity, request.requestId)).toBeNull()
  expect((await getRequest(db, identity, request.requestId)).state).toBe(
    'signing',
  )
  const recovered = await getLatestAttempt(db, identity, request.requestId)
  expect(recovered?.claimToken).not.toBe(claim.token)
  expect(recovered?.messageBase64).toBe(fixture().prepared.messageBase64)
})
