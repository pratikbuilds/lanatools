import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { CreatedTransactionLink, TransactionLink } from '@lanatools/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { createApp } from '../../api/src/app'
import { authorizeGrant } from '../../api/src/mcp-grants'
import { transactionLinks } from '../../api/src/routes/transaction-links'
import type { TransactionLinksEnv } from '../../api/src/routes/transaction-links'
import { testDatabase } from '../../api/src/test-database'
import {
  createTransactionLink,
  transactionLinkStatus,
} from '../../api/src/transactions/requests'
import { createServer } from './server'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

test('MCP creates a D1 link that the anonymous HTTP route reads without preparing', async () => {
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await db
    .prepare(
      "INSERT INTO mcp_grant (id, privy_user_id, client_id, status, scope, created_at) VALUES (?, ?, ?, 'active', '', ?)",
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
        createTransactionLink: (grant, name, input) =>
          createTransactionLink(env, grant, name, input),
        transactionLinkStatus: (grant, id) =>
          transactionLinkStatus(env, grant, id),
        walletAddress: unused,
        payHttp: unused,
        callTool: unused,
        sendFeedback: unused,
      },
      typesafeApiKey: undefined,
      revokeClient: () => {},
    },
    identity,
    [],
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
        idempotencyKey: 'integration-review',
      },
    })
    expect(called.isError).not.toBe(true)
    const created = CreatedTransactionLink.assert(called.structuredContent)
    expect(new URL(created.reviewUrl).pathname).toBe(`/tx/${created.linkId}`)
    const app = createApp<TransactionLinksEnv>().route(
      '/api/transaction-links',
      transactionLinks,
    )
    const response = await app.request(
      `/api/transaction-links/${created.linkId}`,
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
      id: created.linkId,
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
      name: 'get_transaction_request',
      arguments: { linkId: created.linkId },
    })
    expect(status.structuredContent).toEqual(link)
    const row = await db
      .prepare('SELECT * FROM transaction_link WHERE id = ?')
      .bind(created.linkId)
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
