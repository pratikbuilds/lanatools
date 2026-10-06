import { afterAll, beforeAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import {
  getBase64Decoder,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
} from '@solana/kit'
import type { D1Database } from '@cloudflare/workers-types'
import { mcpGrant, transactionAttempt, transactionLink } from '../db/schema'
import { testDatabase } from '../test-database'
import { PAYMENT_NETWORKS } from '../solana/network'
import { createTransactionLinkRoutes } from '../routes/transaction-link'
import {
  createExternalLink,
  prepareExternalLink,
  reviewExternalLink,
  submitExternalLink,
} from './external-link'
import type { ExternalLinkDependencies } from './external-link'
import { getLatestAttempt } from './ledger'
import { verifySignedSolTransfer } from './sol-execution'
import { prepareGrant, recordConsent, revokeGrant } from '../mcp-grants'

const wallet = 'So11111111111111111111111111111111111111112'
const recipient = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const input = {
  idempotencyKey: 'send',
  recipient,
  amountLamports: '1000001',
  externalWallet: null,
}
const envBase = {
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://rpc.invalid/secret',
  SIGNING_LINK_ORIGIN: 'http://localhost:5173',
}
let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 30_000)
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
    createdAt: Date.now(),
  })
  const env = { DB: db, ...envBase }
  const link = await createExternalLink(env, identity, input)
  const token = new URLSearchParams(new URL(link.signingUrl).hash.slice(1)).get(
    'token',
  )!
  let sends = 0,
    preparations = 0,
    height = 50n
  let chain: {
    signedBase64: string
    slot: string
    commitment: 'confirmed' | 'finalized'
    failed: boolean
  } | null = null
  let transportFails = false
  const deps: ExternalLinkDependencies = {
    prepare: async () => {
      preparations++
      return {
        genesisHash: PAYMENT_NETWORKS.devnet.genesisHash,
        slot: 42n,
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 100n,
      }
    },
    verify: (bytes, expected) =>
      verifySignedSolTransfer(bytes, expected, async () => true),
    rpc: async () => ({
      blockHeight: async () => height,
      send: async (wire) => {
        sends++
        if (transportFails) throw new Error('rpc secret')
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
    link,
    token,
    deps,
    sends: () => sends,
    preparations: () => preparations,
    setHeight: (n: bigint) => (height = n),
    setChain: (value: typeof chain) => (chain = value),
    failTransport: () => (transportFails = true),
  }
}
function signed(wire: string) {
  const bytes = new Uint8Array(getBase64Encoder().encode(wire))
  // Non-cryptographic fixture; positive flow injects a verifier, never signs.
  bytes.fill(1, 1, 65)
  return getBase64Decoder().decode(bytes)
}

test('link stores only token hash, fragment carries token and duplicate intent shares one request', async () => {
  const f = await fixture()
  const second = await createExternalLink(f.env, f.identity, input)
  expect(second.requestId).toBe(f.link.requestId)
  expect(second.signingUrl).not.toBe(f.link.signingUrl)
  expect(new URL(second.signingUrl).search).toBe('')
  const rows = await drizzle(db)
    .select()
    .from(transactionLink)
    .where(eq(transactionLink.requestId, f.link.requestId))
  expect(rows).toHaveLength(2)
  expect(rows.some((row) => row.tokenHash === f.token)).toBe(false)
  await expect(
    createExternalLink(f.env, f.identity, { ...input, amountLamports: '2' }),
  ).rejects.toThrow('different transaction')
  const review = await reviewExternalLink(f.env, f.token, f.deps)
  expect(review.state).toBe('requested')
  expect(review.transactionBase64).toBeNull()
  expect(review).not.toHaveProperty('claimToken')
  expect(review).not.toHaveProperty('userId')
})

test('expiry, revocation and mainnet block capability use', async () => {
  const f = await fixture()
  await expect(
    reviewExternalLink(f.env, '0'.repeat(64), f.deps),
  ).rejects.toThrow('unavailable')
  await drizzle(db)
    .update(transactionLink)
    .set({ expiresAt: Date.now() - 1 })
    .where(eq(transactionLink.requestId, f.link.requestId))
  await expect(
    prepareExternalLink(f.env, f.token, wallet, f.deps),
  ).rejects.toThrow('expired')
  const g = await fixture()
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'revoked' })
    .where(eq(mcpGrant.id, g.identity.grantId))
  await expect(reviewExternalLink(g.env, g.token, g.deps)).rejects.toThrow(
    'unavailable',
  )
  await expect(
    createExternalLink(
      { ...g.env, SOLANA_NETWORK: 'mainnet' },
      g.identity,
      input,
    ),
  ).rejects.toThrow('devnet')
})

test('historical links do not prevent reconnect and cannot authorize the new grant', async () => {
  const f = await fixture()
  await revokeGrant(db, f.identity.userId, f.identity.grantId)
  const handle = crypto.randomUUID()
  await recordConsent(db, {
    handle,
    clientId: f.identity.clientId,
    clientName: 'test',
    redirectUri: 'https://client.test/callback',
  })
  const next = await prepareGrant(
    db,
    handle,
    f.identity.clientId,
    f.identity.userId,
  )
  expect(next.grantId).not.toBe(f.identity.grantId)
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'active' })
    .where(eq(mcpGrant.id, next.grantId))
  await expect(reviewExternalLink(f.env, f.token, f.deps)).rejects.toThrow(
    'unavailable',
  )
  const fresh = await createExternalLink(
    f.env,
    { ...f.identity, grantId: next.grantId },
    input,
  )
  expect(fresh.requestId).toBe(f.link.requestId)
})

test('declared wallet mismatch never reads preparation RPC', async () => {
  const f = await fixture()
  const link = await createExternalLink(f.env, f.identity, {
    ...input,
    idempotencyKey: 'bound',
    externalWallet: wallet,
  })
  const token = new URLSearchParams(new URL(link.signingUrl).hash.slice(1)).get(
    'token',
  )!
  await expect(
    prepareExternalLink(f.env, token, recipient, f.deps),
  ).rejects.toThrow('wallet')
  expect(f.preparations()).toBe(0)
})

test('revocation or expiry during signature verification prevents persistence and send', async () => {
  for (const revoke of [true, false]) {
    const f = await fixture()
    const ready = await prepareExternalLink(f.env, f.token, wallet, f.deps)
    const deps: ExternalLinkDependencies = {
      ...f.deps,
      verify: async (bytes, expected) => {
        const verified = await verifySignedSolTransfer(
          bytes,
          expected,
          async () => true,
        )
        if (revoke)
          await drizzle(db)
            .update(mcpGrant)
            .set({ status: 'revoked' })
            .where(eq(mcpGrant.id, f.identity.grantId))
        else
          await drizzle(db)
            .update(transactionLink)
            .set({ expiresAt: Date.now() - 1 })
            .where(eq(transactionLink.requestId, f.link.requestId))
        return verified
      },
    }
    await expect(
      submitExternalLink(
        f.env,
        f.token,
        signed(ready.transactionBase64!),
        deps,
      ),
    ).rejects.toThrow('unavailable')
    expect(f.sends()).toBe(0)
    const attempt = await drizzle(db)
      .select()
      .from(transactionAttempt)
      .where(eq(transactionAttempt.requestId, f.link.requestId))
      .get()
    expect(attempt?.signedBase64).toBeNull()
  }
})

test('concurrent preparation binds once and issues identical persisted message', async () => {
  const f = await fixture()
  const reviews = await Promise.all(
    Array.from({ length: 5 }, () =>
      prepareExternalLink(f.env, f.token, wallet, f.deps),
    ),
  )
  const ready = await reviewExternalLink(f.env, f.token, f.deps)
  expect(ready.state).toBe('issued')
  expect(f.preparations()).toBe(1)
  const attempt = await getLatestAttempt(db, f.identity, f.link.requestId)
  expect(attempt?.state).toBe('issued')
  expect(
    reviews.every(
      (r) =>
        r.transactionBase64 === null ||
        r.transactionBase64 === ready.transactionBase64,
    ),
  ).toBe(true)
  await expect(
    prepareExternalLink(f.env, f.token, recipient, f.deps),
  ).rejects.toThrow('wallet')
})

test('invalid signature and mutated message never persist or broadcast', async () => {
  const f = await fixture()
  const ready = await prepareExternalLink(f.env, f.token, wallet, f.deps)
  const wire = signed(ready.transactionBase64!)
  await expect(
    submitExternalLink(f.env, f.token, wire, {
      ...f.deps,
      verify: verifySignedSolTransfer,
    }),
  ).rejects.toThrow('does not match')
  const bytes = new Uint8Array(getBase64Encoder().encode(wire))
  bytes[bytes.length - 2] = (bytes[bytes.length - 2] ?? 0) ^ 1
  await expect(
    submitExternalLink(
      f.env,
      f.token,
      getBase64Decoder().decode(bytes),
      f.deps,
    ),
  ).rejects.toThrow('does not match')
  expect(
    (await getLatestAttempt(db, f.identity, f.link.requestId))?.signedBase64,
  ).toBeNull()
  expect(f.sends()).toBe(0)
})

test('duplicate submission broadcasts once and only verified chain evidence succeeds', async () => {
  const f = await fixture()
  const ready = await prepareExternalLink(f.env, f.token, wallet, f.deps)
  const wire = signed(ready.transactionBase64!)
  await Promise.all(
    Array.from({ length: 6 }, () =>
      submitExternalLink(f.env, f.token, wire, f.deps),
    ),
  )
  expect(f.sends()).toBe(1)
  let review = await reviewExternalLink(f.env, f.token, f.deps)
  expect(review.state).toBe('submitted')
  f.setChain({
    signedBase64: wire,
    slot: '45',
    commitment: 'confirmed',
    failed: false,
  })
  review = await reviewExternalLink(f.env, f.token, f.deps)
  expect(review.state).toBe('succeeded')
  expect(review.commitment).toBe('confirmed')
  f.setChain({
    signedBase64: wire,
    slot: '45',
    commitment: 'finalized',
    failed: false,
  })
  expect((await reviewExternalLink(f.env, f.token, f.deps)).commitment).toBe(
    'finalized',
  )
  f.setChain({
    signedBase64: wire,
    slot: '45',
    commitment: 'confirmed',
    failed: false,
  })
  expect((await reviewExternalLink(f.env, f.token, f.deps)).commitment).toBe(
    'finalized',
  )
})

test('timeout remains uncertain after expiry, and silence cannot cause replacement', async () => {
  const f = await fixture()
  const ready = await prepareExternalLink(f.env, f.token, wallet, f.deps)
  f.failTransport()
  const wire = signed(ready.transactionBase64!)
  expect((await submitExternalLink(f.env, f.token, wire, f.deps)).state).toBe(
    'uncertain',
  )
  f.setHeight(101n)
  const review = await reviewExternalLink(f.env, f.token, f.deps)
  expect(review.state).toBe('uncertain')
  expect(review.transactionExpired).toBe(true)
  await submitExternalLink(f.env, f.token, wire, f.deps)
  expect(f.sends()).toBe(1)
  expect(
    (await prepareExternalLink(f.env, f.token, wallet, f.deps))
      .transactionBase64,
  ).toBeNull()
  expect(f.preparations()).toBe(1)
})

test('expired prepared wire cannot be issued and revoked grant cannot submit', async () => {
  const f = await fixture()
  f.setHeight(101n)
  await expect(
    prepareExternalLink(f.env, f.token, wallet, f.deps),
  ).rejects.toThrow('lifetime')
  expect(
    (await getLatestAttempt(db, f.identity, f.link.requestId))?.state,
  ).toBe('prepared')
  const g = await fixture()
  const ready = await prepareExternalLink(g.env, g.token, wallet, g.deps)
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'revoked' })
    .where(eq(mcpGrant.id, g.identity.grantId))
  await expect(
    submitExternalLink(
      g.env,
      g.token,
      signed(ready.transactionBase64!),
      g.deps,
    ),
  ).rejects.toThrow('unavailable')
  expect(g.sends()).toBe(0)
})

test('HTTP routes require bearer capability, reject malformed/extra input, never cache', async () => {
  const f = await fixture()
  const app = createTransactionLinkRoutes(f.deps)
  const request = (path: string, init?: RequestInit) =>
    app.request(path, init, f.env)
  const noToken = await request('/')
  expect(noToken.status).toBe(403)
  expect(noToken.headers.get('Cache-Control')).toBe('no-store')
  expect(noToken.headers.get('Referrer-Policy')).toBe('no-referrer')
  const headers = {
    Authorization: `Bearer ${f.token}`,
    'Content-Type': 'application/json',
  }
  expect(
    (await request('/prepare', { method: 'POST', headers, body: '{' })).status,
  ).toBe(400)
  expect(
    (
      await request('/prepare', {
        method: 'POST',
        headers,
        body: JSON.stringify({ walletAddress: wallet, userId: 'spoof' }),
      })
    ).status,
  ).toBe(400)
  const ready = await request('/prepare', {
    method: 'POST',
    headers,
    body: JSON.stringify({ walletAddress: wallet }),
  })
  expect(ready.status).toBe(200)
  expect(
    (
      await request('/submit', {
        method: 'POST',
        headers,
        body: JSON.stringify({ signedBase64: 'x'.repeat(3000) }),
      })
    ).status,
  ).toBe(413)
  const attempts = await drizzle(db)
    .select()
    .from(transactionAttempt)
    .where(eq(transactionAttempt.requestId, f.link.requestId))
  expect(attempts).toHaveLength(1)
})
