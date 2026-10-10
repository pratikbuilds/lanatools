import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { D1Database, RateLimit } from '@cloudflare/workers-types'
import {
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from '@solana/kit'
import type { KeyPairSigner } from '@solana/kit'
import { getAddMemoInstruction } from '@solana-program/memo'
import { PreparedTransaction, TransactionLink } from '@lanatools/contracts'
import type { TransactionReview } from '@lanatools/contracts'
import { drizzle } from 'drizzle-orm/d1'
import { z } from 'zod'
import { createApp } from '../app'
import { mcpGrant } from '../db/schema'
import { createTransactionLinks } from '../routes/transaction-links'
import type { TransactionLinksEnv } from '../routes/transaction-links'
import { PAYMENT_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import { createTransactionRequest } from './requests'
import type { BuilderContext } from './adapter'
import { verifySignedTransaction } from './submission'
import type { TransactionRpc } from './submission'
import { defineTransactionOperation } from '@lanatools/toolkit/transactions'
import { transactionOperation } from './tools'

// These memo-only operations exercise different data shapes, not production integrations.
async function buildMemo(
  memo: string,
  account: string,
  context: BuilderContext,
  review: TransactionReview,
): Promise<PreparedTransaction> {
  const lifetime = await context.rpc.latestBlockhash()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(address(account), value),
    (value) => setTransactionMessageLifetimeUsingBlockhash(lifetime, value),
    (value) =>
      appendTransactionMessageInstructions(
        [getAddMemoInstruction({ memo: `${context.requestId}:${memo}` })],
        value,
      ),
  )
  return {
    transaction: getBase64EncodedWireTransaction(compileTransaction(message)),
    account,
    network: context.network,
    review,
    blockhash: lifetime.blockhash,
    lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
  }
}

const tools = {
  record_note: defineTransactionOperation({
    submission: {
      schema: z.undefined(),
      send: (wire, _candidate, _execution, context: BuilderContext) =>
        context.rpc.send(wire),
    },
    arguments: z.strictObject({ message: z.string().min(1).max(100) }),
    describe: ({ message }) => ({
      title: 'Record a note',
      description: 'Publish this message from your connected wallet.',
      actionLabel: 'Record note',
      fields: [{ label: 'Message', value: message }],
    }),
    build: ({ message }, account, context, review) =>
      buildMemo(message, account, context, review),
  }),
  record_ballot: defineTransactionOperation({
    submission: {
      schema: z.undefined(),
      send: (wire, _candidate, _execution, context: BuilderContext) =>
        context.rpc.send(wire),
    },
    arguments: z.strictObject({
      proposal: z.string().min(1),
      choice: z.enum(['yes', 'no']),
    }),
    describe: ({ proposal, choice }) => ({
      title: 'Record a ballot',
      description: 'Record your choice for this proposal.',
      actionLabel: 'Record ballot',
      fields: [
        { label: 'Proposal', value: proposal },
        { label: 'Choice', value: choice },
      ],
    }),
    build: ({ proposal, choice }, account, context, review) =>
      buildMemo(`${proposal}:${choice}`, account, context, review),
  }),
}

let db: D1Database
let limiter: RateLimit
let dispose: () => Promise<void>
let wallet: KeyPairSigner
beforeAll(async () => {
  const database = await testDatabase()
  db = database.db
  limiter = database.transactionLinkLimiter
  dispose = database.dispose
  wallet = await generateKeyPairSigner()
}, 60_000)
afterAll(() => dispose())

const cases = [
  {
    name: 'record_note',
    args: { message: 'A public note' },
    fields: [{ label: 'Message', value: 'A public note' }],
    memo: 'A public note',
  },
  {
    name: 'record_ballot',
    args: { proposal: 'Community garden', choice: 'yes' },
    fields: [
      { label: 'Proposal', value: 'Community garden' },
      { label: 'Choice', value: 'yes' },
    ],
    memo: 'Community garden:yes',
  },
]

test.each(cases)(
  '$name uses shared persistence, routes and submission',
  async (fixture) => {
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
    const env: TransactionLinksEnv = {
      DB: db,
      TRANSACTION_LINK_LIMITER: limiter,
      SOLANA_NETWORK: 'devnet',
      SOLANA_RPC_URL: 'https://unused.example',
      WEB_ORIGIN: 'http://localhost:5173',
    }
    const input = {
      ...fixture.args,
      delivery: 'link',
      idempotencyKey: crypto.randomUUID(),
    }
    const created = await createTransactionRequest(
      env,
      identity,
      fixture.name,
      input,
      { tools },
    )
    if (!created.ok) throw new Error(created.error.message)
    const id = created.result.id
    expect(created.result.review.fields).toEqual(fixture.fields)
    const persisted = () =>
      db
        .prepare('select * from transaction_request where id = ?')
        .bind(id)
        .first()
    expect(await persisted()).toMatchObject({
      tool_name: fixture.name,
      arguments_json: JSON.stringify(fixture.args),
      candidate_json: null,
      signature: null,
    })
    expect(
      await createTransactionRequest(env, identity, fixture.name, input, {
        tools,
      }),
    ).toMatchObject({ ok: true, result: { id } })

    const broadcasts: string[] = []
    const rpc: TransactionRpc = {
      // These builders never read accounts.
      accounts: {} as TransactionRpc['accounts'],
      genesisHash: async () => PAYMENT_NETWORKS.devnet.genesisHash,
      latestBlockhash: async () => ({
        blockhash: blockhash(PAYMENT_NETWORKS.devnet.genesisHash),
        lastValidBlockHeight: 500n,
      }),
      blockHeight: async () => 100n,
      send: async (transaction) => {
        broadcasts.push(transaction)
        return verifySignedTransaction(transaction, candidate)
      },
      status: async () =>
        broadcasts.length
          ? { err: null, slot: 123n, confirmationStatus: 'confirmed' }
          : null,
    }
    const app = createApp<TransactionLinksEnv>().route(
      '/api/transaction-links',
      createTransactionLinks({
        tools,
        rpc,
        observation: { attempts: 1, intervalMs: 0 },
      }),
    )
    const request = (suffix = '', body?: unknown) =>
      app.request(
        `/api/transaction-links/${id}${suffix}`,
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
        env,
      )
    const initial = await request()
    expect(initial.status).toBe(200)
    expect(TransactionLink.assert(await initial.json())).toMatchObject({
      tool: fixture.name,
      review: { fields: fixture.fields },
      status: 'open',
    })
    const prepared = await request('/transaction', { account: wallet.address })
    expect(prepared.status).toBe(200)
    const candidate = PreparedTransaction.assert(await prepared.json())
    expect(candidate.review.fields).toEqual(fixture.fields)
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(candidate.transaction),
    )
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
    )
    expect(message.feePayer.address).toBe(wallet.address)
    expect(message.instructions).toHaveLength(1)
    expect(new TextDecoder().decode(message.instructions[0].data)).toBe(
      `${id}:${fixture.memo}`,
    )

    // Real cryptographic signing exercises the shared immutable-message boundary.
    const signed = getBase64EncodedWireTransaction(
      await signTransaction([wallet.keyPair], transaction),
    )
    expect(
      (await request('/send', { transaction: candidate.transaction })).status,
    ).toBe(400)
    expect(broadcasts).toHaveLength(0)
    const sent = await request('/send', { transaction: signed })
    expect(sent.status).toBe(200)
    const result = TransactionLink.assert(await sent.json())
    expect(result).toMatchObject({
      tool: fixture.name,
      status: 'confirmed',
      review: { fields: fixture.fields },
      signature: await verifySignedTransaction(signed, candidate),
      receipt: { slot: '123' },
    })
    expect(broadcasts).toEqual([signed])
    const repeated = await request('/send', { transaction: signed })
    expect(TransactionLink.assert(await repeated.json())).toEqual(result)
    expect(TransactionLink.assert(await (await request()).json())).toEqual(
      result,
    )
    expect(broadcasts).toHaveLength(1)
    expect(await persisted()).toMatchObject({
      candidate_json: JSON.stringify(candidate),
      signature: result.signature,
    })
    expect(
      (await request('/transaction', { account: wallet.address })).status,
    ).toBe(409)
  },
)

test('test tools are isolated and registry does not expose inherited object names', () => {
  for (const name of ['record_note', 'record_ballot', 'toString', '__proto__'])
    expect(transactionOperation(name)).toBeNull()
  for (const name of ['toString', '__proto__'])
    expect(transactionOperation(name, tools)).toBeNull()
  expect(
    tools.record_note.arguments.safeParse({
      message: 'hello',
      idempotencyKey: 'x',
      network: 'mainnet',
    }).success,
  ).toBe(false)
  expect(
    tools.record_ballot.arguments.safeParse({
      proposal: 'Garden',
      choice: 'invalid',
      idempotencyKey: 'x',
    }).success,
  ).toBe(false)
})
