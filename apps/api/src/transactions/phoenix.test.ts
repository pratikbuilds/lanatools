import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  signBytes,
} from '@solana/kit'
import type { KeyPairSigner } from '@solana/kit'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { TransactionResult } from '@lanatools/contracts'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import {
  BLOCKHASH,
  KEYS,
  PERMISSION,
  SOL_BOOK,
  SOL_MARKET,
  TRADER_ACCOUNT_DATA,
  accountInfo,
  fakePhoenix,
  fakeRpc,
  tokenAccountData,
} from '../../../../packages/phoenix/src/trade/fixtures'
import {
  PHOENIX_PROGRAM,
  traderAccountAddress,
  usdcAccountAddress,
} from '../../../../packages/phoenix/src/trade/rise'
import { TOKEN_PROGRAM } from '../../../../packages/phoenix/src/trade/checks'
import { mcpGrant, paymentSigner, transactionRequest } from '../db/schema'
import { testDatabase } from '../test-database'
import {
  createTransactionRequest,
  prepareTransactionLink,
  sendTransaction,
  sendTransactionLink,
} from './requests'
import {
  transactionPrograms,
  transactionTools,
  transactionToolInput,
} from './tools'
import { verifySignedTransaction } from './submission'
import type { TransactionRpc } from './submission'

let db: D1Database
let dispose: () => Promise<void>
let wallet: KeyPairSigner
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
  wallet = await generateKeyPairSigner()
}, 60_000)
afterAll(() => dispose())
const observation = { attempts: 1, intervalMs: 0 }
const env = () => ({
  DB: db,
  SOLANA_NETWORK: 'mainnet',
  SOLANA_RPC_URL: 'https://unused.example',
  WEB_ORIGIN: 'http://localhost:5173',
})

async function fixture({
  activation = false,
  uncertain = false,
  simulationFails = false,
} = {}) {
  const trader = await traderAccountAddress(wallet.address)
  const usdc = await usdcAccountAddress(wallet.address)
  let slot = 1000n
  let sent = 0
  const message = `phoenix-wallet-login-v1\nwallet:${wallet.address}\nnonce:nonce-1\nexpires_at:2099-01-01T00:00:00Z`
  const phoenix = fakePhoenix({
    '/v1/view/exchange/keys': KEYS,
    '/v1/view/exchange/market/SOL': SOL_MARKET,
    '/v1/view/orderbook/SOL': SOL_BOOK,
    '/v1/view/exchange/status': { active: true, withdrawalsAvailable: true },
    '/v1/referral/activation-permission': PERMISSION,
    '/v1/auth/nonce': {
      nonce_id: 'nonce-1',
      message,
      expires_at: '2099-01-01T00:00:00Z',
    },
    '/v1/auth/login/wallet': {
      access_token: 'never-persist-this-token',
      expires_at: '2099-01-01T00:00:00Z',
    },
    '/v1/referral/activate-tx': () => {
      sent++
      if (uncertain) throw new Error('response lost after submission')
      return { status: 'submitted', trader_pda: trader }
    },
    [`/v1/trader/state/${wallet.address}`]: {
      authority: wallet.address,
      snapshot: {
        subaccounts: [
          {
            subaccountIndex: 0,
            collateral: '100000000',
            positions: [
              {
                symbol: 'SOL',
                basePositionLots: '100',
                virtualQuotePositionLots: '0',
                accumulatedFundingQuoteLots: '0',
              },
            ],
            orders: [
              {
                symbol: 'SOL',
                orders: [
                  {
                    orderSequenceNumber: '7',
                    priceTicks: '5000',
                    priceUsd: '50',
                    side: 'bid',
                    sizeRemainingLots: '10',
                    change: null,
                    orderType: 'limit',
                    reduceOnly: false,
                    status: 'open',
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  })
  const chain = fakeRpc({
    getAccountInfo: (account) =>
      account === trader && !activation
        ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
        : account === usdc
          ? accountInfo(TOKEN_PROGRAM, tokenAccountData(100_000_000n))
          : { value: null },
    getSlot: () => slot,
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: {
        err: simulationFails
          ? { InstructionError: [0, 'InvalidArgument'] }
          : null,
        unitsConsumed: 500_000n,
        logs: [],
      },
    }),
    sendTransaction: (wire) => {
      sent++
      if (uncertain) throw new Error('response lost after submission')
      const transaction = getTransactionDecoder().decode(
        getBase64Encoder().encode(String(wire)),
      )
      return getBase58Decoder().decode(transaction.signatures[wallet.address]!)
    },
  })
  const rpc: TransactionRpc = {
    accounts: chain.rpc,
    genesisHash: async () => SOLANA_NETWORKS.mainnet.genesisHash,
    latestBlockhash: async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 500n,
    }),
    blockHeight: async () => 100n,
    send: async () => {
      throw new Error('Phoenix owns its relay')
    },
    status: async () =>
      sent && !uncertain
        ? { err: null, slot: 1200n, confirmationStatus: 'confirmed' }
        : null,
  }
  const identity = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: identity.grantId,
    privyUserId: identity.userId,
    clientId: identity.clientId,
    scope: 'account:read phoenix:trade',
    createdAt: Date.now(),
  })
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => phoenix.fetch(String(input), init),
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  return {
    rpc,
    identity,
    phoenix,
    message,
    fetch,
    sent: () => sent,
    expire: () => {
      slot = 10_000n
    },
  }
}
const signed = async (wire: string) =>
  getBase64EncodedWireTransaction(
    await partiallySignTransaction(
      [wallet.keyPair],
      getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
    ),
  )
const login = async (message: string) =>
  getBase58Decoder().decode(
    await signBytes(
      wallet.keyPair.privateKey,
      new TextEncoder().encode(message),
    ),
  )
const row = (id: string) =>
  drizzle(db)
    .select()
    .from(transactionRequest)
    .where(eq(transactionRequest.id, id))
    .get()

const cases = [
  ['phoenix_activate_account', {}],
  ['phoenix_deposit', { amount: '1' }],
  ['phoenix_withdraw', { amount: '1' }],
  [
    'phoenix_market_order',
    { symbol: 'SOL', side: 'buy', size: '0.1', maxSlippageBps: 50 },
  ],
  [
    'phoenix_limit_order',
    { symbol: 'SOL', side: 'buy', size: '0.1', price: '50' },
  ],
  ['phoenix_cancel_orders', { symbol: 'SOL' }],
  ['phoenix_close_position', { symbol: 'SOL', maxSlippageBps: 50 }],
] as const

for (const [tool, args] of cases)
  for (const delivery of ['link', 'local', 'embedded'] as const) {
    test(`${tool} uses ${delivery} signing and the shared receipt`, async () => {
      const f = await fixture({
        activation: tool === 'phoenix_activate_account',
      })
      try {
        if (delivery === 'embedded')
          await drizzle(db).insert(paymentSigner).values({
            privyUserId: f.identity.userId,
            walletId: 'test-wallet',
            walletAddress: wallet.address,
            policyId: 'payment-policy',
            transactionPolicyId: 'transaction-policy',
            status: 'enabled',
            updatedAt: Date.now(),
          })
        const options = {
          rpc: f.rpc,
          observation,
          embeddedSigner: async (_wallet: unknown, wire: string) =>
            signed(wire),
          embeddedMessageSigner: async (_wallet: unknown, message: string) =>
            login(message),
        }
        const input = {
          ...args,
          delivery,
          ...(delivery === 'local' ? { wallet: wallet.address } : {}),
          idempotencyKey: crypto.randomUUID(),
        }
        const result = await createTransactionRequest(
          env(),
          f.identity,
          tool,
          input,
          options,
        )
        if (!result.ok) throw new Error(JSON.stringify(result.error))
        expect(TransactionResult.allows(result.result)).toBe(true)
        const final = result.result
        if (delivery !== 'embedded') {
          const prepared =
            delivery === 'local'
              ? result.result.transaction
              : await prepareTransactionLink(
                  env(),
                  result.result.id,
                  { account: wallet.address },
                  options,
                )
          const candidate =
            prepared && 'ok' in prepared
              ? prepared.ok
                ? prepared.result
                : null
              : prepared
          if (!candidate) throw new Error(JSON.stringify(prepared))
          expect(candidate.review.description).not.toBe('')
          const transaction = await signed(candidate.transaction)
          const messageSignature = candidate.messageToSign
            ? await login(candidate.messageToSign)
            : undefined
          const payload = {
            transaction,
            ...(messageSignature ? { messageSignature } : {}),
          }
          const outcome =
            delivery === 'local'
              ? await sendTransaction(
                  env(),
                  f.identity,
                  result.result.id,
                  payload,
                  options,
                )
              : await sendTransactionLink(
                  env(),
                  result.result.id,
                  payload,
                  options,
                )
          if (!outcome.ok) throw new Error(JSON.stringify(outcome.error))
          expect(outcome.result.status).toBe('confirmed')
          expect(outcome.result.receipt?.commitment).toBe('confirmed')
          expect(
            (
              await sendTransactionLink(
                env(),
                result.result.id,
                payload,
                options,
              )
            ).ok,
          ).toBe(true)
        } else expect(final.status).toBe('confirmed')
        expect(f.sent()).toBe(1)
        const saved = await row(result.result.id)
        expect(saved?.candidateJson).not.toContain('never-persist-this-token')
        expect(JSON.parse(saved!.candidateJson!).transaction).not.toEqual(
          await signed(JSON.parse(saved!.candidateJson!).transaction),
        )
      } finally {
        f.fetch.mockRestore()
      }
    })
  }

test('trade tools preserve validation, scopes, mainnet and signing boundaries', async () => {
  const f = await fixture()
  try {
    const input = {
      symbol: 'SOL',
      side: 'buy',
      size: '0.1',
      delivery: 'local',
      wallet: wallet.address,
      idempotencyKey: crypto.randomUUID(),
    }
    const schema = transactionToolInput(
      transactionTools.phoenix_market_order!.operation,
    )
    expect(schema.safeParse(input).success).toBe(false)
    expect(
      schema.safeParse({ ...input, maxSlippageBps: 50, limitPrice: '100' })
        .success,
    ).toBe(false)
    expect(
      schema.safeParse({ ...input, maxSlippageBps: 50, network: 'mainnet' })
        .success,
    ).toBe(false)
    const args = {
      amount: '1',
      delivery: 'local',
      wallet: wallet.address,
      idempotencyKey: crypto.randomUUID(),
    }
    expect(
      await createTransactionRequest(
        { ...env(), SOLANA_NETWORK: 'devnet' },
        f.identity,
        'phoenix_deposit',
        args,
        { rpc: f.rpc },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    await drizzle(db)
      .update(mcpGrant)
      .set({ scope: 'account:read phoenix:read' })
      .where(eq(mcpGrant.id, f.identity.grantId))
    expect(
      await createTransactionRequest(
        env(),
        f.identity,
        'phoenix_deposit',
        args,
        { rpc: f.rpc },
      ),
    ).toMatchObject({ ok: false, error: { code: 'insufficient_scope' } })
    expect(transactionPrograms()).toContain(PHOENIX_PROGRAM)
    expect(f.sent()).toBe(0)
  } finally {
    f.fetch.mockRestore()
  }
})

for (const activation of [false, true])
  test(`uncertain Phoenix ${activation ? 'activation' : 'trade'} retries observe without resubmitting`, async () => {
    const f = await fixture({ activation, uncertain: true })
    try {
      const result = await createTransactionRequest(
        env(),
        f.identity,
        activation ? 'phoenix_activate_account' : 'phoenix_deposit',
        {
          ...(activation ? {} : { amount: '1' }),
          delivery: 'local',
          wallet: wallet.address,
          idempotencyKey: crypto.randomUUID(),
        },
        { rpc: f.rpc },
      )
      if (!result.ok || !result.result.transaction)
        throw new Error(JSON.stringify(result))
      const candidate = result.result.transaction
      const transaction = await signed(candidate.transaction)
      const messageSignature = candidate.messageToSign
        ? await login(candidate.messageToSign)
        : undefined
      if (activation) {
        expect(
          await sendTransaction(
            env(),
            f.identity,
            result.result.id,
            { transaction },
            { rpc: f.rpc },
          ),
        ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
        expect((await row(result.result.id))?.signature).toBeNull()
      }
      const payload = {
        transaction,
        ...(messageSignature ? { messageSignature } : {}),
      }
      const options = { rpc: f.rpc, observation }
      const results = await Promise.all([
        sendTransaction(env(), f.identity, result.result.id, payload, options),
        sendTransaction(env(), f.identity, result.result.id, payload, options),
      ])
      for (const response of results)
        expect(response).toMatchObject({
          ok: true,
          result: { status: 'unknown' },
        })
      expect(
        await sendTransaction(
          env(),
          f.identity,
          result.result.id,
          payload,
          options,
        ),
      ).toMatchObject({ ok: true, result: { status: 'unknown' } })
      expect(f.sent()).toBe(1)
    } finally {
      f.fetch.mockRestore()
    }
  })

test('an expired Phoenix order is never sent', async () => {
  const f = await fixture()
  try {
    const result = await createTransactionRequest(
      env(),
      f.identity,
      'phoenix_market_order',
      {
        symbol: 'SOL',
        side: 'buy',
        size: '0.1',
        maxSlippageBps: 50,
        delivery: 'local',
        wallet: wallet.address,
        idempotencyKey: crypto.randomUUID(),
      },
      { rpc: f.rpc },
    )
    if (!result.ok || !result.result.transaction)
      throw new Error(JSON.stringify(result))
    f.expire()
    expect(
      await sendTransaction(
        env(),
        f.identity,
        result.result.id,
        { transaction: await signed(result.result.transaction.transaction) },
        { rpc: f.rpc, observation },
      ),
    ).toMatchObject({ ok: true, result: { status: 'failed' } })
    expect(f.sent()).toBe(0)
  } finally {
    f.fetch.mockRestore()
  }
})

test('a failed simulation returns an actionable error and no signing material', async () => {
  const f = await fixture({ simulationFails: true })
  try {
    const result = await createTransactionRequest(
      env(),
      f.identity,
      'phoenix_deposit',
      {
        amount: '1',
        delivery: 'local',
        wallet: wallet.address,
        idempotencyKey: crypto.randomUUID(),
      },
      { rpc: f.rpc },
    )
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'preparation_refused',
        message: expect.stringContaining('simulation failed'),
      },
    })
    expect(f.sent()).toBe(0)
  } finally {
    f.fetch.mockRestore()
  }
})

test('activation rejects a different login signature and an unapproved missing signer', async () => {
  const f = await fixture({ activation: true })
  try {
    const result = await createTransactionRequest(
      env(),
      f.identity,
      'phoenix_activate_account',
      {
        delivery: 'local',
        wallet: wallet.address,
        idempotencyKey: crypto.randomUUID(),
      },
      { rpc: f.rpc },
    )
    if (!result.ok || !result.result.transaction)
      throw new Error(JSON.stringify(result))
    const candidate = result.result.transaction
    const wire = await signed(candidate.transaction)
    await expect(
      verifySignedTransaction(wire, { ...candidate, coSigners: [] }),
    ).rejects.toThrow('Unsupported required signers')
    expect(
      await sendTransaction(
        env(),
        f.identity,
        result.result.id,
        {
          transaction: wire,
          messageSignature: await login('a different nonce'),
        },
        { rpc: f.rpc },
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect((await row(result.result.id))?.signature).toBeNull()
    expect(f.sent()).toBe(0)
  } finally {
    f.fetch.mockRestore()
  }
})

test('already activated accounts report no work without signing or sending', async () => {
  const f = await fixture()
  try {
    expect(
      await createTransactionRequest(
        env(),
        f.identity,
        'phoenix_activate_account',
        {
          delivery: 'local',
          wallet: wallet.address,
          idempotencyKey: crypto.randomUUID(),
        },
        { rpc: f.rpc },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'preparation_refused',
        message: expect.stringContaining('already activated'),
      },
    })
    expect(f.sent()).toBe(0)
  } finally {
    f.fetch.mockRestore()
  }
})

test('uncertain embedded activation retries never sign or submit again', async () => {
  const f = await fixture({ activation: true, uncertain: true })
  try {
    await drizzle(db).insert(paymentSigner).values({
      privyUserId: f.identity.userId,
      walletId: 'test-wallet',
      walletAddress: wallet.address,
      policyId: 'payment-policy',
      transactionPolicyId: 'transaction-policy',
      status: 'enabled',
      updatedAt: Date.now(),
    })
    let transactionSigns = 0
    let messageSigns = 0
    const options = {
      rpc: f.rpc,
      observation,
      embeddedSigner: async (_wallet: unknown, wire: string) => {
        transactionSigns++
        return signed(wire)
      },
      embeddedMessageSigner: async (_wallet: unknown, message: string) => {
        messageSigns++
        return login(message)
      },
    }
    const input = { delivery: 'embedded', idempotencyKey: crypto.randomUUID() }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await createTransactionRequest(
          env(),
          f.identity,
          'phoenix_activate_account',
          input,
          options,
        ),
      ).toMatchObject({ ok: true, result: { status: 'unknown' } })
    }
    expect(transactionSigns).toBe(1)
    expect(messageSigns).toBe(1)
    expect(f.sent()).toBe(1)
  } finally {
    f.fetch.mockRestore()
  }
})
