import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { TransactionNotSubmittedError } from '@lanatools/toolkit/transactions'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import {
  address,
  blockhash,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  decompileTransactionMessage,
  getTransactionDecoder,
  signTransaction,
} from '@solana/kit'
import type { KeyPairSigner } from '@solana/kit'
import type { PreparedTransaction } from '@lanatools/contracts'
import { parseTransferSolInstruction } from '@solana-program/system'
import { mcpGrant, transactionRequest } from '../db/schema'
import { testDatabase } from '../test-database'
import { PAYMENT_NETWORKS } from '../solana/network'
import {
  createTransactionRequest,
  prepareTransactionLink,
  sendTransactionLink,
  readTransactionLink,
  observeTransactionLink,
  transactionStatus,
  PREPARATION_LEASE_MS,
} from './requests'
import { verifySignedTransaction } from './submission'
import type { TransactionRpc } from './submission'
import { solTransfer } from './sol-transfer'

let db: D1Database
let dispose: () => Promise<void>
let wallet: KeyPairSigner
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
  wallet = await generateKeyPairSigner()
}, 60_000)
afterAll(() => dispose())
const env = () => ({
  DB: db,
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://unused.example',
  WEB_ORIGIN: 'http://localhost:5173',
})
const args = {
  recipient: address('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N'),
  amountLamports: '10000001',
}
const observation = { attempts: 1, intervalMs: 0 }
const row = (id: string) =>
  drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, id))
    .get()

function mockRpc(overrides: Partial<TransactionRpc> = {}) {
  const calls: string[] = []
  let sentSignature = ''
  const rpc: TransactionRpc = {
    // These builders never read accounts.
    accounts: {} as TransactionRpc['accounts'],
    genesisHash: async () => {
      calls.push('genesis')
      return PAYMENT_NETWORKS.devnet.genesisHash
    },
    latestBlockhash: async () => {
      calls.push('build')
      return {
        blockhash: blockhash(PAYMENT_NETWORKS.devnet.genesisHash),
        lastValidBlockHeight: 500n,
      }
    },
    blockHeight: async () => {
      calls.push('height')
      return 100n
    },
    send: async () => {
      calls.push('send')
      return sentSignature
    },
    status: async () => {
      calls.push('status')
      return { err: null, slot: 123n, confirmationStatus: 'confirmed' }
    },
    ...overrides,
  }
  return {
    rpc,
    calls,
    setSignature: (value: string) => {
      sentSignature = value
    },
  }
}

async function create() {
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    scope: 'account:read jupiter:read solana:transfer',
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    createdAt: Date.now(),
  })
  const result = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    { ...args, delivery: 'link', idempotencyKey: crypto.randomUUID() },
  )
  if (!result.ok) throw new Error(result.error.message)
  return { id: result.result.id, identity }
}

async function prepare(
  id: string,
  rpc: TransactionRpc,
  account = wallet.address,
) {
  const result = await prepareTransactionLink(env(), id, { account }, { rpc })
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.result
}
async function signed(candidate: PreparedTransaction, signer = wallet) {
  const unsigned = getTransactionDecoder().decode(
    getBase64Encoder().encode(candidate.transaction),
  )
  return getBase64EncodedWireTransaction(
    await signTransaction([signer.keyPair], unsigned),
  )
}

test('SOL builder encodes exact amount, selected fee payer and a unique link memo', async () => {
  const first = await create()
  const second = await create()
  const fake = mockRpc()
  const candidate = await prepare(first.id, fake.rpc)
  const other = await prepare(second.id, fake.rpc)
  expect(candidate.transaction).not.toBe(other.transaction)
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(candidate.transaction),
  )
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
  )
  expect(message.feePayer.address).toBe(wallet.address)
  expect(message.instructions).toHaveLength(2)
  const transfer = parseTransferSolInstruction(
    message.instructions[0] as Parameters<
      typeof parseTransferSolInstruction
    >[0],
  )
  expect(transfer.data.amount).toBe(10000001n)
  expect(transfer.accounts.destination.address).toBe(args.recipient)
  expect(transfer.accounts.source.address).toBe(wallet.address)
  expect(new TextDecoder().decode(message.instructions[1]?.data)).toBe(
    `lanatools:${first.id}`,
  )
  expect(candidate.review.fields[0]?.value).toBe('0.010000001 SOL')
  expect(candidate.lastValidBlockHeight).toBe('500')
  expect((await row(first.id))?.candidateJson).toBe(JSON.stringify(candidate))
  expect(fake.calls).not.toContain('send')
  expect(await readTransactionLink(db, first.id)).toMatchObject({
    status: 'ready',
  })
})

test('concurrent preparation reserves one account and publishes one immutable candidate', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      prepareTransactionLink(
        env(),
        id,
        { account: wallet.address },
        { rpc: fake.rpc },
      ),
    ),
  )
  const successes = results.filter((result) => result.ok)
  expect(successes.length).toBeGreaterThan(0)
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(1)
  const candidate = await prepare(id, fake.rpc)
  expect(
    successes.every(
      (result) => result.result.transaction === candidate.transaction,
    ),
  ).toBe(true)
  const other = await generateKeyPairSigner()
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: other.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(1)
})

test('RPC mismatch fails before building and releases only the unpublished reservation', async () => {
  const { id } = await create()
  const fake = mockRpc({
    genesisHash: async () => PAYMENT_NETWORKS.mainnet.genesisHash,
  })
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(fake.calls).not.toContain('build')
  expect(await row(id)).toMatchObject({
    status: 'open',
    account: null,
    candidateJson: null,
    signature: null,
  })
  expect(
    await prepareTransactionLink(
      { ...env(), SOLANA_NETWORK: 'mainnet' },
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
})

test('grant revocation or link expiry during building prevents candidate publication', async () => {
  for (const closure of ['revoke', 'expire']) {
    const { id, identity } = await create()
    const fake = mockRpc({
      latestBlockhash: async () => {
        if (closure === 'revoke')
          await drizzle(db)
            .update(mcpGrant)
            .set({ status: 'revoked' })
            .where(eq(mcpGrant.id, identity.grantId))
        else
          await drizzle(db)
            .update(transactionRequest)
            .set({ expiresAt: 0 })
            .where(eq(transactionRequest.id, id))
        return {
          blockhash: blockhash(PAYMENT_NETWORKS.devnet.genesisHash),
          lastValidBlockHeight: 500n,
        }
      },
    })
    expect(
      await prepareTransactionLink(
        env(),
        id,
        { account: wallet.address },
        { rpc: fake.rpc },
      ),
    ).toMatchObject({ ok: false })
    expect(await row(id)).toMatchObject({
      candidateJson: null,
      signature: null,
    })
  }
})

test('real Ed25519 signatures are required; altered instructions, amounts, signer and corrupt signatures fail', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const signature = await verifySignedTransaction(wire, candidate)
  expect(signature.length).toBeGreaterThan(80)
  const corrupt = new Uint8Array(getBase64Encoder().encode(wire))
  corrupt[1] = corrupt[1]! ^ 1
  const alteredAmount = await solTransfer.build(
    { ...args, amountLamports: '999' },
    wallet.address,
    { requestId: id, network: 'devnet', rpc: fake.rpc },
  )
  const otherWallet = await generateKeyPairSigner()
  const alteredSigner = await solTransfer.build(args, otherWallet.address, {
    requestId: id,
    network: 'devnet',
    rpc: fake.rpc,
  })
  const alteredMemo = await solTransfer.build(args, wallet.address, {
    requestId: 'other-link',
    network: 'devnet',
    rpc: fake.rpc,
  })
  for (const invalid of [
    candidate.transaction,
    getBase64Decoder().decode(corrupt),
    await signed(alteredAmount),
    await signed(alteredSigner, otherWallet),
    await signed(alteredMemo),
  ]) {
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: invalid },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(fake.calls).not.toContain('send')
  expect((await row(id))?.signature).toBeNull()
})

test('signature is durable before broadcasting; only independent confirmation creates a receipt', async () => {
  const { id } = await create()
  let transactionSignature = ''
  const fake = mockRpc({
    send: async (wire) => {
      const stored = await row(id)
      expect(stored).toMatchObject({
        signature: transactionSignature,
        status: 'submitting',
      })
      expect(stored?.candidateJson).not.toContain(wire)
      expect(stored?.receiptJson).toBeNull()
      return transactionSignature
    },
  })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  transactionSignature = await verifySignedTransaction(wire, candidate)
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({
    ok: true,
    result: {
      status: 'confirmed',
      signature: transactionSignature,
      receipt: {
        signature: transactionSignature,
        slot: '123',
        commitment: 'confirmed',
      },
    },
  })
  expect(await readTransactionLink(db, id)).toMatchObject({
    status: 'confirmed',
    signature: transactionSignature,
  })
  expect((await row(id))?.candidateJson).toBe(JSON.stringify(candidate))
})

test('failed signature persistence prevents every send RPC call', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  await db
    .prepare(
      `create trigger reject_signature before update of signature on transaction_request when new.id = '${id}' begin select raise(abort, 'simulated disk failure'); end`,
    )
    .run()
  try {
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: wire },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(fake.calls).not.toContain('send')
    expect((await row(id))?.signature).toBeNull()
  } finally {
    await db.prepare('drop trigger reject_signature').run()
  }
})

test('expiry and revoked grant block first signature acceptance and sending', async () => {
  for (const closure of ['height', 'expiry', 'grant']) {
    const { id, identity } = await create()
    const fake = mockRpc({
      blockHeight: async () => (closure === 'height' ? 501n : 100n),
    })
    const candidate = await prepare(id, fake.rpc)
    if (closure === 'expiry')
      await drizzle(db)
        .update(transactionRequest)
        .set({ expiresAt: 0 })
        .where(eq(transactionRequest.id, id))
    if (closure === 'grant')
      await drizzle(db)
        .update(mcpGrant)
        .set({ status: 'revoked' })
        .where(eq(mcpGrant.id, identity.grantId))
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: await signed(candidate) },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({
      ok: false,
      error: { code: closure === 'height' ? 'transaction_expired' : 'closed' },
    })
    expect(fake.calls).not.toContain('send')
    expect((await row(id))?.signature).toBeNull()
  }
})

test('accepted RPC response, timeout and processed-only errors never claim confirmed or rebuild', async () => {
  for (const status of [
    null,
    {
      err: { InstructionError: [0, 'error'] },
      slot: 100n,
      confirmationStatus: 'processed' as const,
    },
  ]) {
    const { id } = await create()
    const fake = mockRpc({ status: async () => status })
    const candidate = await prepare(id, fake.rpc)
    const wire = await signed(candidate)
    const sig = await verifySignedTransaction(wire, candidate)
    fake.setSignature(sig)
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: wire },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({
      ok: true,
      result: { status: 'unknown', signature: sig, receipt: null },
    })
    fake.rpc.send = async () => {
      throw new Error('RPC response lost')
    }
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: wire },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({ ok: true, result: { status: 'unknown', signature: sig } })
    expect((await row(id))?.candidateJson).toBe(JSON.stringify(candidate))
    expect(fake.calls.filter((call) => call === 'build')).toHaveLength(1)
  }
})

test('concurrent identical submissions cannot downgrade confirmation', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const sig = await verifySignedTransaction(wire, candidate)
  fake.setSignature(sig)
  const outcomes = await Promise.all(
    Array.from({ length: 3 }, () =>
      sendTransactionLink(
        env(),
        id,
        { transaction: wire },
        { rpc: fake.rpc, observation },
      ),
    ),
  )
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
  expect(await row(id)).toMatchObject({ status: 'confirmed', signature: sig })
  const sendCount = fake.calls.filter((call) => call === 'send').length
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
  expect(fake.calls.filter((call) => call === 'send')).toHaveLength(sendCount)
})

test('reload and authenticated status recover a persisted signature without broadcasting', async () => {
  const { id, identity } = await create()
  const fake = mockRpc({
    status: async () => null,
    send: async () => {
      throw new Error('response lost')
    },
  })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const sig = await verifySignedTransaction(wire, candidate)
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: true, result: { status: 'unknown', signature: sig } })
  fake.calls.length = 0
  fake.rpc.status = async () => ({
    err: null,
    slot: 456n,
    confirmationStatus: 'finalized',
  })
  expect(
    await transactionStatus(env(), identity, id, { rpc: fake.rpc }),
  ).toMatchObject({
    ok: true,
    result: {
      status: 'confirmed',
      signature: sig,
      receipt: { signature: sig, slot: '456', commitment: 'finalized' },
    },
  })
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'confirmed', signature: sig })
  expect(fake.calls).not.toContain('send')
  expect(fake.calls).not.toContain('build')
  expect((await row(id))?.candidateJson).toBe(JSON.stringify(candidate))
})

test('a crash after signature persistence is recoverable using observation only', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const sig = await verifySignedTransaction(await signed(candidate), candidate)
  await drizzle(db)
    .update(transactionRequest)
    .set({ signature: sig, status: 'submitting' })
    .where(eq(transactionRequest.id, id))
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'confirmed', signature: sig })
  expect(fake.calls).not.toContain('send')
})

test('receipt persistence failure retains the signature and a later GET can recover', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const sig = await verifySignedTransaction(wire, candidate)
  fake.setSignature(sig)
  await db
    .prepare(
      `create trigger reject_receipt before update of receipt_json on transaction_request when new.id = '${id}' begin select raise(abort, 'simulated receipt write failure'); end`,
    )
    .run()
  try {
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: wire },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await row(id)).toMatchObject({
      signature: sig,
      status: 'submitting',
      receiptJson: null,
    })
    expect(
      await observeTransactionLink(env(), id, { rpc: fake.rpc }),
    ).toMatchObject({ signature: sig, status: 'submitting', receipt: null })
  } finally {
    await db.prepare('drop trigger reject_receipt').run()
  }
  const sends = fake.calls.filter((call) => call === 'send').length
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'confirmed', signature: sig })
  expect(fake.calls.filter((call) => call === 'send')).toHaveLength(sends)
})

test('status RPC failure keeps an accepted signature unknown without inventing a receipt', async () => {
  const { id } = await create()
  const fake = mockRpc({
    status: async () => {
      throw new Error('provider unavailable')
    },
  })
  const candidate = await prepare(id, fake.rpc)
  const sig = await verifySignedTransaction(await signed(candidate), candidate)
  await drizzle(db)
    .update(transactionRequest)
    .set({ signature: sig, status: 'submitting' })
    .where(eq(transactionRequest.id, id))
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'unknown', signature: sig, receipt: null })
  fake.rpc.genesisHash = async () => {
    throw new Error('provider unavailable')
  }
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'unknown', signature: sig, receipt: null })
  expect(fake.calls).not.toContain('send')
})

test('expired unpublished preparation is projected open and stale builders cannot publish or release a new reservation', async () => {
  const { id } = await create()
  const now = Date.now()
  let release!: () => void
  let started!: () => void
  const building = new Promise<void>((resolve) => {
    started = resolve
  })
  const paused = new Promise<void>((resolve) => {
    release = resolve
  })
  const slow = mockRpc({
    latestBlockhash: async () => {
      started()
      await paused
      return {
        blockhash: blockhash(PAYMENT_NETWORKS.devnet.genesisHash),
        lastValidBlockHeight: 500n,
      }
    },
  })
  const first = prepareTransactionLink(
    env(),
    id,
    { account: wallet.address },
    { rpc: slow.rpc, now },
  )
  await building
  const leaseExpiredAt = now + PREPARATION_LEASE_MS
  expect(await readTransactionLink(db, id, leaseExpiredAt - 1)).toMatchObject({
    status: 'preparing',
    account: wallet.address,
  })
  expect(
    await observeTransactionLink(env(), id, {
      now: leaseExpiredAt,
      rpc: slow.rpc,
    }),
  ).toMatchObject({ status: 'open', account: null })
  const other = await generateKeyPairSigner()
  const fresh = mockRpc()
  const recovered = await prepareTransactionLink(
    env(),
    id,
    { account: other.address },
    { rpc: fresh.rpc, now: leaseExpiredAt },
  )
  expect(recovered.ok).toBe(true)
  const saved = await row(id)
  release()
  expect(await first).toMatchObject({
    ok: false,
    error: { code: 'unavailable' },
  })
  expect(await row(id)).toEqual(saved)
  expect(saved).toMatchObject({
    status: 'ready',
    account: other.address,
    revision: 3,
    signature: null,
  })
  expect(fresh.calls.filter((call) => call === 'build')).toHaveLength(1)
})

function allowRenewal(fake: ReturnType<typeof mockRpc>) {
  fake.rpc.blockHeight = async (commitment) => {
    expect(commitment === 'confirmed' || commitment === 'finalized').toBe(true)
    return 501n
  }
  fake.rpc.latestBlockhash = async () => {
    fake.calls.push('build')
    return {
      blockhash: blockhash('11111111111111111111111111111111'),
      lastValidBlockHeight: 800n,
    }
  }
}

test('an expired blockhash does not expire a still-valid link', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const before = await row(id)
  allowRenewal(fake)
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({
    status: 'transaction_expired',
    signature: null,
    account: wallet.address,
    expiresAt: before!.expiresAt,
  })
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(1)
  const next = await prepare(id, fake.rpc)
  expect(next.transaction).not.toBe(candidate.transaction)
  expect(await row(id)).toMatchObject({
    status: 'ready',
    account: wallet.address,
    signature: null,
    expiresAt: before!.expiresAt,
    revision: 4,
  })
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(2)
  expect(fake.calls).not.toContain('send')
})

test('legacy blockhash-expired rows recover within the same TTL and grant, never by extending either', async () => {
  for (const closure of ['live', 'ttl', 'grant']) {
    const { id, identity } = await create()
    const fake = mockRpc()
    const candidate = await prepare(id, fake.rpc)
    const before = await row(id)
    await drizzle(db)
      .update(transactionRequest)
      .set({
        status: 'expired',
        errorCode: 'blockhash_expired',
        ...(closure === 'ttl' ? { expiresAt: 0 } : {}),
      })
      .where(eq(transactionRequest.id, id))
    if (closure === 'grant')
      await drizzle(db)
        .update(mcpGrant)
        .set({ status: 'revoked' })
        .where(eq(mcpGrant.id, identity.grantId))
    allowRenewal(fake)
    expect(
      await observeTransactionLink(env(), id, { rpc: fake.rpc }),
    ).toMatchObject({
      status:
        closure === 'live'
          ? 'transaction_expired'
          : closure === 'ttl'
            ? 'expired'
            : 'unavailable',
    })
    const outcome = await prepareTransactionLink(
      env(),
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    )
    if (closure === 'live') {
      expect(outcome.ok).toBe(true)
      expect(outcome.ok && outcome.result.transaction).not.toBe(
        candidate.transaction,
      )
      expect((await row(id))?.expiresAt).toBe(before!.expiresAt)
    } else {
      expect(outcome).toMatchObject({ ok: false, error: { code: 'closed' } })
      expect((await row(id))?.candidateJson).toBe(JSON.stringify(candidate))
    }
  }
})

test('renewal waits for finalized expiry and cannot use confirmed height as proof', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  fake.rpc.blockHeight = async (commitment) =>
    commitment === 'finalized' ? 500n : 501n
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'ready' })
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'preparing' } })
  await drizzle(db)
    .update(transactionRequest)
    .set({ status: 'expired', errorCode: 'blockhash_expired' })
    .where(eq(transactionRequest.id, id))
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'preparing' } })
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(1)
  expect((await row(id))?.candidateJson).toBe(JSON.stringify(candidate))
})

test('concurrent renewals publish one fresh candidate, retain the same wallet and deadline', async () => {
  const { id } = await create()
  const fake = mockRpc()
  await prepare(id, fake.rpc)
  const before = await row(id)
  allowRenewal(fake)
  const other = await generateKeyPairSigner()
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: other.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      prepareTransactionLink(
        env(),
        id,
        { account: wallet.address },
        { rpc: fake.rpc },
      ),
    ),
  )
  const successful = results.filter((result) => result.ok)
  expect(successful.length).toBeGreaterThan(0)
  expect(
    new Set(successful.map((result) => result.result.transaction)).size,
  ).toBe(1)
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(2)
  expect(await row(id)).toMatchObject({
    status: 'ready',
    signature: null,
    account: wallet.address,
    expiresAt: before!.expiresAt,
  })
})

test('an accepted signature forbids candidate renewal even after finalized expiry', async () => {
  const { id } = await create()
  const fake = mockRpc({ status: async () => null })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const signature = await verifySignedTransaction(wire, candidate)
  fake.setSignature(signature)
  await sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: fake.rpc, observation },
  )
  allowRenewal(fake)
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'closed' } })
  expect(await row(id)).toMatchObject({
    status: 'unknown',
    signature,
    candidateJson: JSON.stringify(candidate),
  })
  expect(fake.calls.filter((call) => call === 'build')).toHaveLength(1)
})

test('renewal fences an old send that passed message validation before the candidate changed', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const previous = await prepare(id, fake.rpc)
  const wire = await signed(previous)
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const delayed = mockRpc({
    blockHeight: async () => {
      started()
      await gate
      return 100n
    },
  })
  const oldSend = sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: delayed.rpc, observation },
  )
  await waiting
  allowRenewal(fake)
  const next = await prepare(id, fake.rpc)
  release()
  expect(await oldSend).toMatchObject({
    ok: false,
    error: { code: 'transaction_expired', retryable: true },
  })
  expect(await row(id)).toMatchObject({
    candidateJson: JSON.stringify(next),
    signature: null,
    status: 'ready',
  })
  expect(delayed.calls).not.toContain('send')
})

test('acceptance before a pending renewal wins and prevents replacing the candidate', async () => {
  const { id } = await create()
  const fake = mockRpc({ status: async () => null })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const signature = await verifySignedTransaction(wire, candidate)
  fake.setSignature(signature)
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const delayed = mockRpc({
    blockHeight: async () => {
      started()
      await gate
      return 501n
    },
  })
  const renewal = prepareTransactionLink(
    env(),
    id,
    { account: wallet.address },
    { rpc: delayed.rpc },
  )
  await waiting
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: true, result: { status: 'unknown', signature } })
  release()
  expect(await renewal).toMatchObject({ ok: false, error: { code: 'closed' } })
  expect(await row(id)).toMatchObject({
    candidateJson: JSON.stringify(candidate),
    signature,
    status: 'unknown',
  })
  expect(delayed.calls).not.toContain('build')
})

test('expiry rejection cannot tell the browser to discard bytes accepted by a competing send', async () => {
  const { id } = await create()
  const fake = mockRpc({ status: async () => null })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const signature = await verifySignedTransaction(wire, candidate)
  fake.setSignature(signature)
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const delayed = mockRpc({
    blockHeight: async () => {
      started()
      await gate
      return 501n
    },
    status: async () => null,
  })
  const expiredSend = sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: delayed.rpc, observation },
  )
  await waiting
  await sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: fake.rpc, observation },
  )
  release()
  expect(await expiredSend).toMatchObject({
    ok: true,
    result: { status: 'expired', signature },
  })
  expect(await row(id)).toMatchObject({ signature, status: 'expired' })
  expect(delayed.calls).not.toContain('send')
})

test('failed and crashed renewals preserve the reserved wallet and permit a fenced retry', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  allowRenewal(fake)
  const latest = fake.rpc.latestBlockhash
  fake.rpc.latestBlockhash = async () => {
    throw new Error('RPC unavailable')
  }
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: wallet.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(await row(id)).toMatchObject({
    status: 'transaction_expired',
    account: wallet.address,
    candidateJson: JSON.stringify(candidate),
    signature: null,
  })
  await drizzle(db)
    .update(transactionRequest)
    .set({ status: 'preparing', updatedAt: Date.now() - PREPARATION_LEASE_MS })
    .where(eq(transactionRequest.id, id))
  expect(await readTransactionLink(db, id)).toMatchObject({
    status: 'transaction_expired',
    account: wallet.address,
  })
  const other = await generateKeyPairSigner()
  expect(
    await prepareTransactionLink(
      env(),
      id,
      { account: other.address },
      { rpc: fake.rpc },
    ),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  fake.rpc.latestBlockhash = latest
  const next = await prepare(id, fake.rpc)
  expect(next.transaction).not.toBe(candidate.transaction)
  expect((await row(id))?.account).toBe(wallet.address)
})

test('accepted signature survives blockhash expiry and closure; retries observe without relaying', async () => {
  for (const closure of ['height', 'grant', 'expiry']) {
    const { id, identity } = await create()
    const fake = mockRpc({ status: async () => null })
    const candidate = await prepare(id, fake.rpc)
    const wire = await signed(candidate)
    const sig = await verifySignedTransaction(wire, candidate)
    fake.setSignature(sig)
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    )
    const sends = fake.calls.filter((call) => call === 'send').length
    if (closure === 'height') fake.rpc.blockHeight = async () => 501n
    if (closure === 'grant')
      await drizzle(db)
        .update(mcpGrant)
        .set({ status: 'revoked' })
        .where(eq(mcpGrant.id, identity.grantId))
    if (closure === 'expiry')
      await drizzle(db)
        .update(transactionRequest)
        .set({ expiresAt: 0 })
        .where(eq(transactionRequest.id, id))
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction: wire },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({
      ok: true,
      result: {
        status: closure === 'height' ? 'expired' : 'unknown',
        signature: sig,
        receipt: null,
      },
    })
    expect(fake.calls.filter((call) => call === 'send')).toHaveLength(sends)
    fake.rpc.status = async () => ({
      err: null,
      slot: 789n,
      confirmationStatus: 'confirmed',
    })
    expect(
      await observeTransactionLink(env(), id, { rpc: fake.rpc }),
    ).toMatchObject({ status: 'confirmed', signature: sig })
    expect((await row(id))?.candidateJson).toBe(JSON.stringify(candidate))
  }
})

test('a stale unknown observation cannot downgrade a competing confirmed receipt', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const sig = await verifySignedTransaction(await signed(candidate), candidate)
  await drizzle(db)
    .update(transactionRequest)
    .set({ status: 'submitting', signature: sig })
    .where(eq(transactionRequest.id, id))
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const stale = mockRpc({
    status: async () => {
      started()
      await gate
      return null
    },
  })
  const oldRead = observeTransactionLink(env(), id, { rpc: stale.rpc })
  await waiting
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'confirmed' })
  release()
  expect(await oldRead).toMatchObject({
    status: 'confirmed',
    receipt: { signature: sig },
  })
  expect((await row(id))?.receiptJson).not.toBeNull()
})

test('confirmed chain failure closes the link and keeps its signature', async () => {
  const { id } = await create()
  const fake = mockRpc({
    status: async () => ({
      err: { InstructionError: [0, 'error'] },
      slot: 111n,
      confirmationStatus: 'confirmed',
    }),
  })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const sig = await verifySignedTransaction(wire, candidate)
  fake.setSignature(sig)
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({
    ok: true,
    result: { status: 'failed', signature: sig, receipt: null },
  })
  const sends = fake.calls.filter((call) => call === 'send').length
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: true, result: { status: 'failed', signature: sig } })
  expect(fake.calls.filter((call) => call === 'send')).toHaveLength(sends)
})

test('a lost send response still confirms only from independent chain evidence', async () => {
  const { id } = await create()
  let sends = 0
  const fake = mockRpc({
    send: async () => {
      sends++
      throw new Error('response lost after broadcast')
    },
  })
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const sig = await verifySignedTransaction(wire, candidate)
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({
    ok: true,
    result: { status: 'confirmed', signature: sig, receipt: { slot: '123' } },
  })
  expect(sends).toBe(1)
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
  expect(sends).toBe(1)
})

test('a mismatched observation RPC never contributes chain evidence or sends', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const sig = await verifySignedTransaction(await signed(candidate), candidate)
  await drizzle(db)
    .update(transactionRequest)
    .set({ signature: sig, status: 'submitting' })
    .where(eq(transactionRequest.id, id))
  fake.calls.length = 0
  fake.rpc.genesisHash = async () => PAYMENT_NETWORKS.mainnet.genesisHash
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'submitting', signature: sig, receipt: null })
  expect(fake.calls).toEqual([])
})

test('a builder cannot publish a candidate for a different selected account or deployment network', async () => {
  const other = await generateKeyPairSigner()
  for (const mismatch of ['account', 'network']) {
    const { id } = await create()
    const fake = mockRpc()
    const tool = solTransfer
    const tools = {
      solana_transfer: {
        ...tool,
        build: async (...params: Parameters<typeof tool.build>) => {
          const candidate = await tool.build(...params)
          return mismatch === 'account'
            ? { ...candidate, account: other.address }
            : { ...candidate, network: 'mainnet' as const }
        },
      },
    }
    expect(
      await prepareTransactionLink(
        env(),
        id,
        { account: wallet.address },
        { rpc: fake.rpc, tools },
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await row(id)).toMatchObject({
      status: 'open',
      account: null,
      candidateJson: null,
      signature: null,
    })
    expect(fake.calls).not.toContain('send')
  }
})

test('confirmed expiry waits for finalized proof without accepting a signature or sending', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  const commitments: Array<string | undefined> = []
  fake.rpc.blockHeight = async (commitment) => {
    commitments.push(commitment)
    return commitment === 'finalized' ? 500n : 501n
  }
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'unavailable', retryable: true },
  })
  expect(commitments).toEqual(['confirmed', 'finalized'])
  expect(await row(id)).toMatchObject({
    status: 'ready',
    signature: null,
    candidateJson: JSON.stringify(candidate),
  })
  expect(fake.calls).not.toContain('send')
  fake.rpc.blockHeight = async () => 501n
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: wire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'transaction_expired', retryable: true },
  })
  expect(await row(id)).toMatchObject({
    status: 'transaction_expired',
    signature: null,
  })
  allowRenewal(fake)
  expect((await prepare(id, fake.rpc)).transaction).not.toBe(
    candidate.transaction,
  )
})

test('an old wallet response arriving after renewal is rejected without accepting or relaying', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const previous = await prepare(id, fake.rpc)
  const oldWire = await signed(previous)
  allowRenewal(fake)
  const next = await prepare(id, fake.rpc)
  expect(
    await sendTransactionLink(
      env(),
      id,
      { transaction: oldWire },
      { rpc: fake.rpc, observation },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(await row(id)).toMatchObject({
    status: 'ready',
    signature: null,
    candidateJson: JSON.stringify(next),
  })
  expect(fake.calls).not.toContain('send')
})

test('a concurrent expiry observation definitively rejects an old pending send', async () => {
  const { id } = await create()
  const fake = mockRpc()
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const delayed = mockRpc({
    blockHeight: async () => {
      started()
      await gate
      return 100n
    },
  })
  const send = sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: delayed.rpc, observation },
  )
  await waiting
  allowRenewal(fake)
  expect(
    await observeTransactionLink(env(), id, { rpc: fake.rpc }),
  ).toMatchObject({ status: 'transaction_expired', signature: null })
  release()
  expect(await send).toMatchObject({
    ok: false,
    error: { code: 'transaction_expired' },
  })
  expect(delayed.calls).not.toContain('send')
  expect((await row(id))?.signature).toBeNull()
})

test('a first relay refusal cannot override a concurrent successful submission', async () => {
  const { id } = await create()
  let landed = false
  let signature = ''
  let firstEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve
  })
  let refuseFirst!: () => void
  const refusal = new Promise<void>((resolve) => {
    refuseFirst = resolve
  })
  let finishSecond!: () => void
  const finish = new Promise<void>((resolve) => {
    finishSecond = resolve
  })
  let secondEntered!: () => void
  const second = new Promise<void>((resolve) => {
    secondEntered = resolve
  })
  const fake = mockRpc({
    status: async () =>
      landed
        ? { err: null, slot: 123n, confirmationStatus: 'confirmed' }
        : null,
  })
  let sends = 0
  const tools = {
    solana_transfer: {
      ...solTransfer,
      relay: () => async () => {
        if (++sends === 1) {
          firstEntered()
          await refusal
          throw new TransactionNotSubmittedError(
            'preflight refused this attempt',
          )
        }
        secondEntered()
        await finish
        landed = true
        return signature
      },
    },
  }
  const candidate = await prepare(id, fake.rpc)
  const wire = await signed(candidate)
  signature = await verifySignedTransaction(wire, candidate)
  const firstRequest = sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: fake.rpc, tools, observation },
  )
  await entered
  const secondRequest = sendTransactionLink(
    env(),
    id,
    { transaction: wire },
    { rpc: fake.rpc, tools, observation },
  )
  await second
  refuseFirst()
  await firstRequest
  finishSecond()
  await secondRequest
  const recovered = await observeTransactionLink(env(), id, {
    rpc: fake.rpc,
    tools,
    observation,
  })
  expect(sends).toBe(2)
  expect(landed).toBe(true)
  expect(recovered?.status).toBe('confirmed')
}, 20_000)
