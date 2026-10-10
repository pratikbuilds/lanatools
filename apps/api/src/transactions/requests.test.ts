import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { TransactionResult, TransactionLink } from '@lanatools/contracts'
import { mcpGrant, transactionRequest } from '../db/schema'
import { testDatabase } from '../test-database'
import {
  activateGrant,
  prepareGrant,
  recordConsent,
  revokeGrant,
} from '../mcp-grants'
import {
  createTransactionRequest,
  readTransactionLink,
  transactionStatus,
} from './requests'
import { transactionToolInput, transactionTools } from './tools'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

const recipient = '11111111111111111111111111111111'
const input = {
  recipient,
  amountLamports: '10000000',
  delivery: 'link',
  idempotencyKey: 'test-request',
}
const env = () => ({
  DB: db,
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://unused.example',
  WEB_ORIGIN: 'http://localhost:5173',
})
async function connect(status: 'active' | 'pending' | 'revoked' = 'active') {
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
    status,
    createdAt: Date.now(),
  })
  return identity
}
async function create() {
  const identity = await connect()
  const outcome = await createTransactionRequest(
    env(),
    identity,
    'solana_transfer',
    input,
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  return { identity, link: outcome.result }
}

test('a grant with the tool scope creates an unsigned link intent', async () => {
  const { identity, link } = await create()
  expect(TransactionResult.allows(link)).toBe(true)
  expect(link).toMatchObject({
    tool: 'solana_transfer',
    delivery: 'link',
    status: 'open',
    signature: null,
    receipt: null,
  })
  expect(link.reviewUrl).toBe(`http://localhost:5173/tx/${link.id}`)
  const row = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, link.id))
    .get()
  expect(row).toMatchObject({
    toolName: 'solana_transfer',
    network: 'devnet',
    creatorUserId: identity.userId,
    creatorClientId: identity.clientId,
    creatorGrantId: identity.grantId,
    argumentsJson: JSON.stringify({ recipient, amountLamports: '10000000' }),
    delivery: 'link',
    account: null,
    candidateJson: null,
    signature: null,
    receiptJson: null,
    errorCode: null,
    revision: 0,
    status: 'open',
  })
  expect(link.expiresAt).toBe(row!.createdAt + 15 * 60_000)
  expect(link.review.fields).toEqual([
    { label: 'Amount', value: '0.01 SOL' },
    { label: 'Recipient', value: recipient },
  ])
})

test('each transaction tool needs its own scope and a known delivery', async () => {
  const identity = await connect()
  await drizzle(db)
    .update(mcpGrant)
    .set({ scope: 'account:read jupiter:read' })
    .where(eq(mcpGrant.id, identity.grantId))
  expect(
    await createTransactionRequest(env(), identity, 'solana_transfer', input),
  ).toMatchObject({ ok: false, error: { code: 'insufficient_scope' } })
  const allowed = await connect()
  for (const delivery of ['local', 'remote', undefined])
    expect(
      await createTransactionRequest(env(), allowed, 'solana_transfer', {
        ...input,
        delivery,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(
    await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.creatorUserId, identity.userId)),
  ).toHaveLength(0)
})

test('concurrent identical requests return one row; changed terms conflict', async () => {
  const identity = await connect()
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      createTransactionRequest(env(), identity, 'solana_transfer', input),
    ),
  )
  expect(results.every((result) => result.ok)).toBe(true)
  expect(
    new Set(results.map((result) => result.ok && result.result.id)).size,
  ).toBe(1)
  expect(
    await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.creatorUserId, identity.userId)),
  ).toHaveLength(1)
  expect(
    await createTransactionRequest(env(), identity, 'solana_transfer', {
      ...input,
      amountLamports: '2',
    }),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(
    await createTransactionRequest(
      { ...env(), SOLANA_NETWORK: 'mainnet' },
      identity,
      'solana_transfer',
      input,
    ),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
})

test('reconnecting rejects old request keys without reviving their links', async () => {
  const { identity, link } = await create()
  const before = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, link.id))
    .get()
  await revokeGrant(db, identity.userId, identity.grantId)
  const handle = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId: identity.clientId,
    clientName: 'Reconnected client',
    redirectUri: 'https://client.example/callback',
  })
  const { grantId } = await prepareGrant(
    db,
    handle,
    identity.clientId,
    identity.userId,
  )
  const reconnected = { ...identity, grantId }
  await activateGrant(db, handle, reconnected, ['solana:transfer'])
  expect(grantId).not.toBe(identity.grantId)
  expect(
    await createTransactionRequest(
      env(),
      reconnected,
      'solana_transfer',
      input,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'conflict',
      message:
        'This request key belongs to a previous connection. Use a new idempotency key.',
      retryable: false,
    },
  })
  expect(await readTransactionLink(db, link.id)).toMatchObject({
    status: 'unavailable',
  })
  expect(
    await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.id, link.id))
      .get(),
  ).toEqual(before)
  const freshInput = { ...input, idempotencyKey: crypto.randomUUID() }
  const fresh = await createTransactionRequest(
    env(),
    reconnected,
    'solana_transfer',
    freshInput,
  )
  if (!fresh.ok) throw new Error(fresh.error.message)
  expect(fresh.result.id).not.toBe(link.id)
  expect(await readTransactionLink(db, fresh.result.id)).toMatchObject({
    status: 'open',
  })
  expect(
    await createTransactionRequest(
      env(),
      reconnected,
      'solana_transfer',
      freshInput,
    ),
  ).toEqual(fresh)
})

test('idempotency is scoped to user and client, not a global request key', async () => {
  const first = await create()
  const second = await create()
  expect(first.link.id).not.toBe(second.link.id)
  const otherClient = {
    ...first.identity,
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    scope: 'account:read jupiter:read solana:transfer',
    id: otherClient.grantId,
    privyUserId: otherClient.userId,
    clientId: otherClient.clientId,
    createdAt: Date.now(),
  })
  const outcome = await createTransactionRequest(
    env(),
    otherClient,
    'solana_transfer',
    input,
  )
  expect(outcome.ok && outcome.result.id).not.toBe(first.link.id)
  expect(
    await transactionStatus(env(), second.identity, first.link.id),
  ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(
    await transactionStatus(env(), otherClient, first.link.id),
  ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(
    await transactionStatus(env(), first.identity, first.link.id),
  ).toMatchObject({ ok: true, result: { id: first.link.id } })
})

test('inactive and forged identities cannot create or inspect creator status', async () => {
  for (const status of ['revoked', 'pending'] as const) {
    const identity = await connect(status)
    expect(
      await createTransactionRequest(env(), identity, 'solana_transfer', input),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  }
  const { identity, link } = await create()
  for (const forged of [
    { ...identity, userId: 'another-user' },
    { ...identity, clientId: 'another-client' },
    { ...identity, grantId: 'another-grant' },
  ]) {
    expect(
      await createTransactionRequest(env(), forged, 'solana_transfer', input),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await transactionStatus(env(), forged, link.id)).toMatchObject({
      ok: false,
      error: { code: 'unauthorized' },
    })
  }
})

test('strict inputs reject signer, network, malformed amounts and unregistered tools', async () => {
  const identity = await connect()
  for (const invalid of [
    null,
    {},
    { ...input, network: 'mainnet' },
    { ...input, account: recipient },
    { ...input, creatorUserId: 'forged' },
    { ...input, recipient: 'no-wallet' },
    ...['0', '-1', '01', '1.5', '1e9', 'abc', '18446744073709551616'].map(
      (amountLamports) => ({ ...input, amountLamports }),
    ),
    { ...input, idempotencyKey: '' },
  ]) {
    expect(
      await createTransactionRequest(
        env(),
        identity,
        'solana_transfer',
        invalid,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(
    transactionToolInput(transactionTools.solana_transfer!.operation).safeParse(
      { ...input, amountLamports: '18446744073709551615' },
    ).success,
  ).toBe(true)
  expect(
    await createTransactionRequest(env(), identity, 'arbitrary_tool', input),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(
    await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.creatorUserId, identity.userId)),
  ).toHaveLength(0)
})

test('network and returned origin come only from validated deployment configuration', async () => {
  const identity = await connect()
  const result = await createTransactionRequest(
    { ...env(), SOLANA_NETWORK: 'mainnet', WEB_ORIGIN: 'https://lanatools.sh' },
    identity,
    'solana_transfer',
    input,
  )
  expect(result).toMatchObject({ ok: true, result: { network: 'mainnet' } })
  if (result.ok)
    expect(result.result.reviewUrl).toBe(
      `https://lanatools.sh/tx/${result.result.id}`,
    )
  for (const override of [
    { SOLANA_NETWORK: 'testnet' },
    { WEB_ORIGIN: 'https://lanatools.sh/evil' },
    { WEB_ORIGIN: 'https://user:secret@lanatools.sh' },
    { WEB_ORIGIN: 'http://external.example' },
  ])
    expect(
      await createTransactionRequest(
        { ...env(), ...override },
        await connect(),
        'solana_transfer',
        input,
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
})

test('public reads allowlist fields and reflect expiry/revocation without changing execution', async () => {
  const { identity, link } = await create()
  const before = await drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, link.id))
    .get()
  const publicLink = await readTransactionLink(db, link.id)
  expect(TransactionLink.allows(publicLink)).toBe(true)
  expect(Object.keys(publicLink!).sort()).toEqual([
    'account',
    'createdAt',
    'expiresAt',
    'id',
    'network',
    'receipt',
    'review',
    'signature',
    'status',
    'tool',
  ])
  expect(publicLink).toMatchObject({
    account: null,
    signature: null,
    status: 'open',
  })
  expect(await readTransactionLink(db, link.id, link.expiresAt)).toMatchObject({
    status: 'expired',
  })
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'revoked' })
    .where(eq(mcpGrant.id, identity.grantId))
  expect(await readTransactionLink(db, link.id)).toMatchObject({
    status: 'unavailable',
  })
  expect(
    await drizzle(db)
      .select()
      .from(transactionRequest)
      .where(eq(transactionRequest.id, link.id))
      .get(),
  ).toEqual(before)
  expect(await readTransactionLink(db, 'missing')).toBeNull()
})
