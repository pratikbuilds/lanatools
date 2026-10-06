import { afterAll, beforeAll, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { type } from 'arktype'
import type { D1Database } from '@cloudflare/workers-types'
import { mcpGrant } from '../db/schema'
import { testDatabase } from '../test-database'
import { PAYMENT_NETWORKS } from '../solana/network'
import { createRequest, getLatestAttempt, selectExternalWallet } from './ledger'
import { prepareSolTransfer } from './prepare'

const wallet = 'So11111111111111111111111111111111111111112'
const recipient = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const env = {
  SOLANA_NETWORK: 'devnet',
  SOLANA_RPC_URL: 'https://rpc.invalid/private-key',
}
const rpc = {
  genesisHash: PAYMENT_NETWORKS.devnet.genesisHash,
  slot: 42n,
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 100n,
}
const intent = {
  action: 'transfer_sol',
  execution: 'embedded',
  idempotencyKey: 'send',
  recipient,
  amountLamports: '1000000',
} as const
const context = {
  network: 'devnet',
  embeddedWallet: { id: 'owned', address: wallet },
} as const
const RpcRequest = type({
  id: 'string | number',
  method: 'string',
  'params?': 'unknown',
})
let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
})
afterAll(async () => {
  await dispose()
})
async function connect() {
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
  return identity
}

test('embedded preparation persists exact bytes, RPC context and no signing evidence', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  const result = await prepareSolTransfer(
    db,
    identity,
    request.requestId,
    env,
    async () => rpc,
  )
  expect(result.state).toBe('prepared')
  expect(result).not.toHaveProperty('messageBase64')
  const attempt = await getLatestAttempt(db, identity, request.requestId)
  expect(attempt?.preparationSlot).toBe('42')
  expect(attempt?.lastValidBlockHeight).toBe('100')
  expect(attempt?.messageBase64).toBeTruthy()
  expect(attempt?.signedBase64).toBeNull()
})

test('concurrent preparation reads RPC once and persists one attempt', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  let reads = 0
  await Promise.all(
    Array.from({ length: 8 }, () =>
      prepareSolTransfer(db, identity, request.requestId, env, async () => {
        reads++
        return rpc
      }),
    ),
  )
  expect(reads).toBe(1)
  expect(
    (await getLatestAttempt(db, identity, request.requestId))?.number,
  ).toBe(1)
})

test('unknown external source must bind before preparation', async () => {
  const identity = await connect()
  const request = await createRequest(
    db,
    identity,
    { ...intent, execution: 'external', externalWallet: null },
    { network: 'devnet', embeddedWallet: null },
  )
  await expect(
    prepareSolTransfer(db, identity, request.requestId, env, async () => rpc),
  ).rejects.toThrow('Select the external wallet')
  expect(
    await getLatestAttempt(db, identity, request.requestId),
  ).toBeUndefined()
  await selectExternalWallet(db, identity, request.requestId, wallet)
  expect(
    (
      await prepareSolTransfer(
        db,
        identity,
        request.requestId,
        env,
        async () => rpc,
      )
    ).state,
  ).toBe('prepared')
})

test('mainnet configuration and another client fail before RPC', async () => {
  const identity = await connect()
  const other = await connect()
  const request = await createRequest(db, identity, intent, context)
  let reads = 0
  const read = async () => {
    reads++
    return rpc
  }
  await expect(
    prepareSolTransfer(
      db,
      identity,
      request.requestId,
      { ...env, SOLANA_NETWORK: 'mainnet' },
      read,
    ),
  ).rejects.toThrow('devnet')
  await expect(
    prepareSolTransfer(db, other, request.requestId, env, read),
  ).rejects.toThrow('unavailable')
  expect(reads).toBe(0)
})

test('wrong genesis and RPC failure preserve unprepared claim without releasing bytes', async () => {
  for (const read of [
    async () => ({ ...rpc, genesisHash: PAYMENT_NETWORKS.mainnet.genesisHash }),
    async () => {
      throw new Error(env.SOLANA_RPC_URL)
    },
  ]) {
    const identity = await connect()
    const request = await createRequest(db, identity, intent, context)
    try {
      await prepareSolTransfer(db, identity, request.requestId, env, read)
      throw new Error('Expected refusal')
    } catch (error) {
      expect(String(error)).not.toContain('private-key')
    }
    const attempt = await getLatestAttempt(db, identity, request.requestId)
    expect(attempt?.state).toBe('preparing')
    expect(attempt?.messageBase64).toBeNull()
  }
})

test('revocation during RPC prevents durable preparation and byte release', async () => {
  const identity = await connect()
  const request = await createRequest(db, identity, intent, context)
  await expect(
    prepareSolTransfer(db, identity, request.requestId, env, async () => {
      await drizzle(db)
        .update(mcpGrant)
        .set({ status: 'revoked' })
        .where(eq(mcpGrant.id, identity.grantId))
      return rpc
    }),
  ).rejects.toThrow('claimed attempt')
})

test('production Kit reader verifies genesis before confirmed blockhash context', async () => {
  const methods: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = RpcRequest.assert(await request.json())
      methods.push(body.method)
      if (body.method === 'getLatestBlockhash')
        expect(body.params).toEqual([{ commitment: 'confirmed' }])
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'getGenesisHash'
            ? rpc.genesisHash
            : {
                context: { slot: 73 },
                value: { blockhash: rpc.blockhash, lastValidBlockHeight: 150 },
              },
      })
    },
  })
  try {
    const identity = await connect()
    const request = await createRequest(db, identity, intent, context)
    await prepareSolTransfer(db, identity, request.requestId, {
      ...env,
      SOLANA_RPC_URL: server.url.toString(),
    })
    expect(methods).toEqual(['getGenesisHash', 'getLatestBlockhash'])
    const attempt = await getLatestAttempt(db, identity, request.requestId)
    expect(attempt?.preparationSlot).toBe('73')
    expect(attempt?.lastValidBlockHeight).toBe('150')
  } finally {
    await server.stop(true)
  }
})

test('production Kit reader rejects wrong genesis before requesting blockhash', async () => {
  const methods: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = RpcRequest.assert(await request.json())
      methods.push(body.method)
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: PAYMENT_NETWORKS.mainnet.genesisHash,
      })
    },
  })
  try {
    const identity = await connect()
    const request = await createRequest(db, identity, intent, context)
    await expect(
      prepareSolTransfer(db, identity, request.requestId, {
        ...env,
        SOLANA_RPC_URL: server.url.toString(),
      }),
    ).rejects.toThrow('Could not prepare')
    expect(methods).toEqual(['getGenesisHash'])
    expect(
      (await getLatestAttempt(db, identity, request.requestId))?.messageBase64,
    ).toBeNull()
  } finally {
    await server.stop(true)
  }
})
