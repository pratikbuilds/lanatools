import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { TransactionResult, TransactionLink } from '@lanatools/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { createApp } from '../../api/src/app'
import { authorizeGrant } from '../../api/src/mcp-grants'
import { transactionLinks } from '../../api/src/routes/transaction-links'
import type { TransactionLinksEnv } from '../../api/src/routes/transaction-links'
import { testDatabase } from '../../api/src/test-database'
import {
  createTransactionRequest,
  transactionStatus,
} from '../../api/src/transactions/requests'
import { createServer } from './server'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

test('an MCP transaction tool creates a D1 link that the anonymous HTTP route reads without preparing', async () => {
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await db
    .prepare(
      "INSERT INTO mcp_grant (id, privy_user_id, client_id, status, scope, created_at) VALUES (?, ?, ?, 'active', 'account:read solana:transfer', ?)",
    )
    .bind(identity.grantId, identity.userId, identity.clientId, Date.now())
    .run()
  const env = {
    DB: db,
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: 'https://unused.example',
    WEB_ORIGIN: 'http://localhost:5173',
  }
  const unused = async (): Promise<never> => {
    throw new Error('Review links must not access payment or wallet services')
  }
  const server = createServer(
    {
      api: {
        whoami: async (grant) =>
          (await authorizeGrant(db, grant, null)) === 'active'
            ? { userId: grant.userId, clientId: grant.clientId }
            : null,
        createTransactionRequest: (grant, name, input) =>
          createTransactionRequest(env, grant, name, input),
        transactionStatus: (grant, id) => transactionStatus(env, grant, id),
        walletAddress: unused,
        payHttp: unused,
        callTool: unused,
        sendFeedback: unused,
      },
      typesafeApiKey: undefined,
      revokeClient: () => {},
    },
    identity,
    ['account:read', 'solana:transfer'],
  )
  const client = new Client({
    name: 'transaction-link integration',
    version: '1',
  })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  try {
    const called = await client.callTool({
      name: 'solana_transfer',
      arguments: {
        recipient: '11111111111111111111111111111111',
        amountLamports: '10000001',
        delivery: 'link',
        idempotencyKey: 'integration-review',
      },
    })
    expect(called.isError).not.toBe(true)
    const created = TransactionResult.assert(called.structuredContent)
    expect(created).toMatchObject({ delivery: 'link', status: 'open' })
    expect(new URL(created.reviewUrl ?? '').pathname).toBe(`/tx/${created.id}`)
    const app = createApp<TransactionLinksEnv>().route(
      '/api/transaction-links',
      transactionLinks,
    )
    const response = await app.request(
      `/api/transaction-links/${created.id}`,
      {},
      {
        ...env,
        SOLANA_RPC_URL: 'https://unused.example',
        TRANSACTION_LINK_LIMITER: { limit: async () => ({ success: true }) },
      },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const link = TransactionLink.assert(await response.json())
    expect(link).toMatchObject({
      id: created.id,
      network: 'devnet',
      status: 'open',
      account: null,
      signature: null,
    })
    expect(link.review.fields).toContainEqual({
      label: 'Amount',
      value: '0.010000001 SOL',
    })
    const status = await client.callTool({
      name: 'get_transaction_status',
      arguments: { id: created.id },
    })
    expect(status.structuredContent).toEqual(created)
    const row = await db
      .prepare('SELECT * FROM transaction_request WHERE id = ?')
      .bind(created.id)
      .first()
    expect(row).toMatchObject({
      status: 'open',
      account: null,
      candidate_json: null,
      signature: null,
    })
    expect(link).not.toHaveProperty('creatorUserId')
    expect(link).not.toHaveProperty('candidate')
  } finally {
    await client.close()
    await server.close()
  }
})
