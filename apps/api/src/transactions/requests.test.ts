import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { CreatedTransactionLink, TransactionLink } from '@lanatools/contracts'
import { mcpGrant, transactionLink } from '../db/schema'
import { testDatabase } from '../test-database'
import {
  createTransactionLink,
  readTransactionLink,
  transactionLinkStatus,
} from './requests'
import { SolanaTransferInput } from './tools'

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
  const outcome = await createTransactionLink(
    env(),
    identity,
    'solana_transfer',
    input,
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  return { identity, link: outcome.result }
}

test('a scope-free active grant creates an unsigned public intent', async () => {
  const { identity, link } = await create()
  expect(CreatedTransactionLink.allows(link)).toBe(true)
  expect(link.reviewUrl).toBe(`http://localhost:5173/tx/${link.linkId}`)
  const row = await drizzle(db)
    .select()
    .from(transactionLink)
    .where(eq(transactionLink.id, link.linkId))
    .get()
  expect(row).toMatchObject({
    toolName: 'solana_transfer',
    network: 'devnet',
    creatorUserId: identity.userId,
    creatorClientId: identity.clientId,
    creatorGrantId: identity.grantId,
    argumentsJson: JSON.stringify({ recipient, amountLamports: '10000000' }),
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

test('concurrent identical requests return one row; changed terms conflict', async () => {
  const identity = await connect()
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      createTransactionLink(env(), identity, 'solana_transfer', input),
    ),
  )
  expect(results.every((result) => result.ok)).toBe(true)
  expect(
    new Set(results.map((result) => result.ok && result.result.linkId)).size,
  ).toBe(1)
  expect(
    await drizzle(db)
      .select()
      .from(transactionLink)
      .where(eq(transactionLink.creatorUserId, identity.userId)),
  ).toHaveLength(1)
  expect(
    await createTransactionLink(env(), identity, 'solana_transfer', {
      ...input,
      amountLamports: '2',
    }),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
  expect(
    await createTransactionLink(
      { ...env(), SOLANA_NETWORK: 'mainnet' },
      identity,
      'solana_transfer',
      input,
    ),
  ).toMatchObject({ ok: false, error: { code: 'conflict' } })
})

test('idempotency is scoped to user and client, not a global request key', async () => {
  const first = await create()
  const second = await create()
  expect(first.link.linkId).not.toBe(second.link.linkId)
  const otherClient = {
    ...first.identity,
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: otherClient.grantId,
    privyUserId: otherClient.userId,
    clientId: otherClient.clientId,
    createdAt: Date.now(),
  })
  const outcome = await createTransactionLink(
    env(),
    otherClient,
    'solana_transfer',
    input,
  )
  expect(outcome.ok && outcome.result.linkId).not.toBe(first.link.linkId)
  expect(
    await transactionLinkStatus(env(), second.identity, first.link.linkId),
  ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(
    await transactionLinkStatus(env(), otherClient, first.link.linkId),
  ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  expect(
    await transactionLinkStatus(env(), first.identity, first.link.linkId),
  ).toMatchObject({ ok: true, result: { id: first.link.linkId } })
})

test('inactive and forged identities cannot create or inspect creator status', async () => {
  for (const status of ['revoked', 'pending'] as const) {
    const identity = await connect(status)
    expect(
      await createTransactionLink(env(), identity, 'solana_transfer', input),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  }
  const { identity, link } = await create()
  for (const forged of [
    { ...identity, userId: 'another-user' },
    { ...identity, clientId: 'another-client' },
    { ...identity, grantId: 'another-grant' },
  ]) {
    expect(
      await createTransactionLink(env(), forged, 'solana_transfer', input),
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(
      await transactionLinkStatus(env(), forged, link.linkId),
    ).toMatchObject({
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
      await createTransactionLink(env(), identity, 'solana_transfer', invalid),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(
    SolanaTransferInput.safeParse({
      ...input,
      amountLamports: '18446744073709551615',
    }).success,
  ).toBe(true)
  expect(
    await createTransactionLink(env(), identity, 'arbitrary_tool', input),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(
    await drizzle(db)
      .select()
      .from(transactionLink)
      .where(eq(transactionLink.creatorUserId, identity.userId)),
  ).toHaveLength(0)
})

test('network and returned origin come only from validated deployment configuration', async () => {
  const identity = await connect()
  const result = await createTransactionLink(
    { ...env(), SOLANA_NETWORK: 'mainnet', WEB_ORIGIN: 'https://lanatools.sh' },
    identity,
    'solana_transfer',
    input,
  )
  expect(result).toMatchObject({ ok: true, result: { network: 'mainnet' } })
  if (result.ok)
    expect(result.result.reviewUrl).toBe(
      `https://lanatools.sh/tx/${result.result.linkId}`,
    )
  for (const override of [
    { SOLANA_NETWORK: 'testnet' },
    { WEB_ORIGIN: 'https://lanatools.sh/evil' },
    { WEB_ORIGIN: 'https://user:secret@lanatools.sh' },
    { WEB_ORIGIN: 'http://external.example' },
  ])
    expect(
      await createTransactionLink(
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
    .from(transactionLink)
    .where(eq(transactionLink.id, link.linkId))
    .get()
  const publicLink = await readTransactionLink(db, link.linkId)
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
  expect(
    await readTransactionLink(db, link.linkId, link.expiresAt),
  ).toMatchObject({ status: 'expired' })
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'revoked' })
    .where(eq(mcpGrant.id, identity.grantId))
  expect(await readTransactionLink(db, link.linkId)).toMatchObject({
    status: 'unavailable',
  })
  expect(
    await drizzle(db)
      .select()
      .from(transactionLink)
      .where(eq(transactionLink.id, link.linkId))
      .get(),
  ).toEqual(before)
  expect(await readTransactionLink(db, 'missing')).toBeNull()
})
