import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { JupiterClient } from '@lanatools/jupiter'
import type { BuildSwapData, JupiterOutcome } from '@lanatools/jupiter'
import type { PreparedTransaction } from '@lanatools/contracts'
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
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
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { mcpGrant, transactionLink } from '../db/schema'
import { PAYMENT_NETWORKS } from '../solana/network'
import { testDatabase } from '../test-database'
import {
  createTransactionLink,
  observeTransactionLink,
  prepareTransactionLink,
  readTransactionLink,
  sendTransactionLink,
} from './requests'
import { verifySignedTransaction } from './submission'
import type { TransactionRpc } from './submission'

const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const sol = 'So11111111111111111111111111111111111111112'
const args = {
  inputMint: usdc,
  outputMint: sol,
  amount: '1',
  maxSlippageBps: 50,
}
const observation = { attempts: 1, intervalMs: 0 }
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
  SOLANA_NETWORK: 'mainnet',
  SOLANA_RPC_URL: 'https://unused.example',
  JUPITER_API_KEY: 'fixture-only',
  WEB_ORIGIN: 'http://localhost:5173',
})
const row = (id: string) =>
  drizzle(db)
    .select()
    .from(transactionLink)
    .where(eq(transactionLink.id, id))
    .get()

async function identity() {
  const result = {
    userId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    grantId: crypto.randomUUID(),
  }
  await drizzle(db).insert(mcpGrant).values({
    id: result.grantId,
    privyUserId: result.userId,
    clientId: result.clientId,
    createdAt: Date.now(),
  })
  return result
}

async function create() {
  const result = await createTransactionLink(
    env(),
    await identity(),
    'jupiter_build_swap',
    {
      ...args,
      idempotencyKey: crypto.randomUUID(),
    },
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.result.linkId
}

// A locally encoded v0 transaction exercises ALT/signature handling without a real swap.
function wire(payer = wallet.address) {
  const loadedAccount = address(usdc)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) => setTransactionMessageFeePayer(payer, value),
    (value) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(PAYMENT_NETWORKS.mainnet.genesisHash),
          lastValidBlockHeight: 500n,
        },
        value,
      ),
    (value) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: address(
              'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            ),
            accounts: [
              { address: wallet.address, role: AccountRole.READONLY_SIGNER },
              { address: loadedAccount, role: AccountRole.READONLY },
            ],
            data: new TextEncoder().encode('swap fixture'),
          },
        ],
        value,
      ),
    (value) =>
      compressTransactionMessageUsingAddressLookupTables(value, {
        [address(sol)]: [loadedAccount],
      }),
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}

function swap(overrides: Partial<BuildSwapData> = {}): BuildSwapData {
  return {
    inputMint: usdc,
    outputMint: sol,
    inputAmount: { decimal: '1', baseUnits: '1000000', decimals: 6 },
    expectedOutput: { decimal: '0.01', baseUnits: '10000000', decimals: 9 },
    minimumOutput: { decimal: '0.00995', baseUnits: '9950000', decimals: 9 },
    slippageBps: 50,
    priceImpact: null,
    fees: { signatureFeePayer: wallet.address },
    routePlan: [],
    router: 'metis',
    constraints: { maxSlippageBps: 50, minOutputAmount: null, satisfied: true },
    providerQuote: {},
    wallet: wallet.address,
    transaction: wire(),
    requestId: 'private-order-id',
    lastValidBlockHeight: '500',
    expireAt: null,
    ...overrides,
  }
}

function success<T>(data: T): JupiterOutcome<T> {
  return {
    ok: true,
    result: {
      source: 'jupiter',
      network: 'mainnet-beta',
      fetchedAt: new Date().toISOString(),
      data,
      warnings: [],
    },
  }
}

function mockRpc() {
  const broadcasts: string[] = []
  let chainStatus: Awaited<ReturnType<TransactionRpc['status']>> = null
  const rpc: TransactionRpc = {
    genesisHash: async () => PAYMENT_NETWORKS.mainnet.genesisHash,
    latestBlockhash: async () => {
      throw new Error('Provider owns the blockhash')
    },
    blockHeight: async () => 100n,
    send: async (value) => {
      broadcasts.push(value)
      throw new Error('Use Jupiter execute')
    },
    status: async () => chainStatus,
  }
  return {
    rpc,
    broadcasts,
    confirmed() {
      chainStatus = { err: null, slot: 123n, confirmationStatus: 'confirmed' }
    },
  }
}

async function prepared(id: string, rpc: TransactionRpc) {
  const result = await prepareTransactionLink(
    env(),
    id,
    { account: wallet.address },
    { rpc },
  )
  if (!result.ok) throw new Error(result.error.message)
  return result.result
}

async function signed(candidate: PreparedTransaction) {
  return getBase64EncodedWireTransaction(
    await signTransaction(
      [wallet.keyPair],
      getTransactionDecoder().decode(
        getBase64Encoder().encode(candidate.transaction),
      ),
    ),
  )
}

test('Jupiter links enforce deployment mainnet and explicit slippage without choosing a wallet', async () => {
  const creator = await identity()
  const input = { ...args, idempotencyKey: crypto.randomUUID() }
  const { maxSlippageBps: _slippage, ...withoutSlippage } = input
  for (const invalid of [
    withoutSlippage,
    { ...input, wallet: wallet.address },
    { ...input, account: wallet.address },
    { ...input, network: 'mainnet' },
    { ...input, outputMint: usdc },
  ]) {
    expect(
      await createTransactionLink(
        env(),
        creator,
        'jupiter_build_swap',
        invalid,
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  }
  expect(
    await createTransactionLink(
      { ...env(), SOLANA_NETWORK: 'devnet' },
      creator,
      'jupiter_build_swap',
      input,
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  const created = await createTransactionLink(
    env(),
    creator,
    'jupiter_build_swap',
    input,
  )
  expect(created).toMatchObject({
    ok: true,
    result: {
      network: 'mainnet',
      review: {
        title: 'Swap USDC for SOL',
        fields: [
          { label: 'You pay', value: '1 USDC' },
          { label: 'You receive', value: 'SOL' },
          { label: 'Maximum slippage', value: '0.5%' },
        ],
      },
    },
  })
  if (!created.ok) throw new Error(created.error.message)
  expect(await row(created.result.linkId)).toMatchObject({
    account: null,
    signature: null,
    candidateJson: null,
    argumentsJson: JSON.stringify(args),
  })
})

test('Jupiter ALT candidate resumes publicly, persists private execution data and accepts before relay', async () => {
  const prepare = spyOn(
    JupiterClient.prototype,
    'prepareSwap',
  ).mockResolvedValue(success(swap()))
  const execute = spyOn(JupiterClient.prototype, 'executeSwap')
  try {
    const id = await create()
    const fake = mockRpc()
    const candidate = await prepared(id, fake.rpc)
    expect(prepare).toHaveBeenCalledWith({ ...args, wallet: wallet.address })
    const decoded = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(
        getBase64Encoder().encode(candidate.transaction),
      ).messageBytes,
    )
    expect(decoded.version).toBe(0)
    expect(decoded).toHaveProperty('addressTableLookups', [
      expect.objectContaining({ lookupTableAddress: sol }),
    ])
    expect(candidate).not.toHaveProperty('execution')
    expect(await prepared(id, fake.rpc)).toEqual(candidate)
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(JSON.parse((await row(id))!.candidateJson!)).toHaveProperty(
      'execution',
      { requestId: 'private-order-id' },
    )
    expect(JSON.stringify(await readTransactionLink(db, id))).not.toContain(
      'private-order-id',
    )
    expect(candidate.review.fields).toContainEqual({
      label: 'Minimum receive',
      value: '0.00995 SOL',
    })
    const transaction = await signed(candidate)
    const signature = await verifySignedTransaction(transaction, candidate)
    execute.mockImplementation(async (input) => {
      expect(await row(id)).toMatchObject({ signature, status: 'submitting' })
      expect(input).toEqual({
        signedTransaction: transaction,
        requestId: 'private-order-id',
        lastValidBlockHeight: '500',
      })
      fake.confirmed()
      return success({ status: 'Success', signature, code: 0 })
    })
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({
      ok: true,
      result: {
        status: 'confirmed',
        signature,
        receipt: { signature, slot: '123' },
      },
    })
    expect(fake.broadcasts).toEqual([])
    const persisted = await row(id)
    expect(persisted?.candidateJson).toContain(candidate.transaction)
    expect(JSON.stringify(persisted)).not.toContain(transaction)
    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({ ok: true, result: { status: 'confirmed' } })
    expect(execute).toHaveBeenCalledTimes(1)
  } finally {
    prepare.mockRestore()
    execute.mockRestore()
  }
})

test('Jupiter rejects a corrupted request ID before accepting a valid signed transaction', async () => {
  const prepare = spyOn(
    JupiterClient.prototype,
    'prepareSwap',
  ).mockResolvedValue(success(swap()))
  const execute = spyOn(JupiterClient.prototype, 'executeSwap')
  try {
    const id = await create()
    const fake = mockRpc()
    const candidate = await prepared(id, fake.rpc)
    const transaction = await signed(candidate)
    await drizzle(db)
      .update(transactionLink)
      .set({
        candidateJson: JSON.stringify({
          ...candidate,
          execution: { requestId: ' \t\n ' },
        }),
      })
      .where(eq(transactionLink.id, id))

    expect(
      await sendTransactionLink(
        env(),
        id,
        { transaction },
        { rpc: fake.rpc, observation },
      ),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(await row(id)).toMatchObject({
      status: 'ready',
      signature: null,
      receiptJson: null,
    })
    expect(execute).not.toHaveBeenCalled()
    expect(fake.broadcasts).toEqual([])
  } finally {
    prepare.mockRestore()
    execute.mockRestore()
  }
})

test.each(['response lost', 'provider success'] as const)(
  'Jupiter %s stays unknown until RPC confirms and cannot create another candidate',
  async (mode) => {
    const prepare = spyOn(
      JupiterClient.prototype,
      'prepareSwap',
    ).mockResolvedValue(success(swap()))
    const execute = spyOn(JupiterClient.prototype, 'executeSwap')
    try {
      const id = await create()
      const fake = mockRpc()
      const candidate = await prepared(id, fake.rpc)
      const transaction = await signed(candidate)
      const signature = await verifySignedTransaction(transaction, candidate)
      execute.mockImplementation(async () => {
        if (mode === 'response lost') throw new Error('connection lost')
        return success({ status: 'Success', signature, code: 0 })
      })
      expect(
        await sendTransactionLink(
          env(),
          id,
          { transaction },
          { rpc: fake.rpc, observation },
        ),
      ).toMatchObject({
        ok: true,
        result: { status: 'unknown', signature, receipt: null },
      })
      expect(
        await prepareTransactionLink(
          env(),
          id,
          { account: wallet.address },
          { rpc: fake.rpc },
        ),
      ).toMatchObject({ ok: false })
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(
        await sendTransactionLink(
          env(),
          id,
          { transaction },
          { rpc: fake.rpc, observation },
        ),
      ).toMatchObject({ ok: true, result: { status: 'unknown', signature } })
      expect(execute).toHaveBeenCalledTimes(2)
      for (const [input] of execute.mock.calls)
        expect(input).toEqual({
          signedTransaction: transaction,
          requestId: 'private-order-id',
          lastValidBlockHeight: '500',
        })
      fake.confirmed()
      expect(
        await observeTransactionLink(env(), id, { rpc: fake.rpc, observation }),
      ).toMatchObject({ status: 'confirmed', signature })
      expect(fake.broadcasts).toEqual([])
      expect(JSON.stringify(await row(id))).not.toContain(transaction)
    } finally {
      prepare.mockRestore()
      execute.mockRestore()
    }
  },
)

test.each([
  'RFQ',
  'sponsored payer',
  'additional signer',
  'missing lifetime',
  'expired lifetime',
  'no minimum output',
] as const)(
  'Jupiter rejects %s before publishing a candidate',
  async (policy) => {
    const overrides: Partial<BuildSwapData> =
      policy === 'RFQ'
        ? { router: 'jupiterz' }
        : policy === 'sponsored payer'
          ? { fees: { signatureFeePayer: sol } }
          : policy === 'additional signer'
            ? { transaction: wire(address(sol)) }
            : policy === 'missing lifetime'
              ? { lastValidBlockHeight: null }
              : policy === 'expired lifetime'
                ? { lastValidBlockHeight: '50' }
                : { minimumOutput: null }
    const prepare = spyOn(
      JupiterClient.prototype,
      'prepareSwap',
    ).mockResolvedValue(success(swap(overrides)))
    try {
      const id = await create()
      expect(
        await prepareTransactionLink(
          env(),
          id,
          { account: wallet.address },
          { rpc: mockRpc().rpc },
        ),
      ).toMatchObject({ ok: false })
      expect(await row(id)).toMatchObject({
        candidateJson: null,
        signature: null,
      })
    } finally {
      prepare.mockRestore()
    }
  },
)
