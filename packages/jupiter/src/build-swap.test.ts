import { expect, test } from 'bun:test'
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { JupiterClient, jupiterSwapTool, jupiterTools } from './index'
import type { JupiterClientOptions } from './index'

const sol = 'So11111111111111111111111111111111111111112'
const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const wallet = 'GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ'
const input = {
  inputMint: usdc,
  outputMint: sol,
  amount: '10.000001',
  wallet,
  maxSlippageBps: 50,
  minOutputAmount: '0.12',
} as const

function wire(signer = wallet, payer = signer, version: 0 | 'legacy' = 0) {
  return getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version }),
        (message) => setTransactionMessageFeePayer(address(payer), message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: blockhash(sol), lastValidBlockHeight: 123n },
            message,
          ),
        (message) =>
          appendTransactionMessageInstructions(
            [
              {
                programAddress: address(
                  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
                ),
                accounts: [
                  {
                    address: address(signer),
                    role: AccountRole.READONLY_SIGNER,
                  },
                ],
                data: getUtf8Encoder().encode('fixture'),
              },
            ],
            message,
          ),
      ),
    ),
  )
}

const transaction = wire()
function reader(overrides: Record<string, unknown> = {}, decimals = 6) {
  const calls: URL[] = []
  const options: JupiterClientOptions = {
    apiKey: 'server-key',
    fetch: async (url, init) => {
      const parsed = new URL(url)
      calls.push(parsed)
      expect(init?.method).toBe('GET')
      expect(init?.headers).toMatchObject({ 'x-api-key': 'server-key' })
      if (parsed.pathname === '/tokens/v2/search')
        return Response.json([
          { id: usdc, decimals },
          { id: sol, decimals: 9 },
        ])
      expect(parsed.pathname).toBe('/swap/v2/order')
      return Response.json({
        inputMint: usdc,
        outputMint: sol,
        inAmount: '10000001',
        outAmount: '123456789',
        otherAmountThreshold: '120000000',
        swapMode: 'ExactIn',
        slippageBps: 50,
        router: 'metis',
        taker: wallet,
        transaction,
        requestId: 'request-1',
        lastValidBlockHeight: '9007199254740993',
        feeBps: 2,
        platformFee: { amount: '20000', feeBps: 2, feeMint: usdc },
        routePlan: [
          { swapInfo: { label: 'fixture' }, transaction: 'nested-payload' },
        ],
        ...overrides,
      })
    },
  }
  return { client: new JupiterClient(options), calls, options }
}

test('the swap tool owns the shared operation and selects its signer at execution', async () => {
  expect(jupiterSwapTool.name).toBe('jupiter_swap')
  expect(jupiterTools.map((tool) => tool.name)).not.toContain('jupiter_swap')
  const operation = jupiterSwapTool.transaction
  const { wallet: _wallet, ...arguments_ } = input
  expect(operation.supportedNetworks).toEqual(['mainnet'])
  expect(operation.arguments.safeParse(input).success).toBe(false)
  expect(
    operation.arguments.safeParse({ ...arguments_, maxSlippageBps: undefined })
      .success,
  ).toBe(false)
  const { options, calls } = reader({ signatureFeePayer: wallet })
  const candidate = await operation.build(arguments_, wallet, {
    ...options,
    network: 'mainnet',
    blockHeight: async () => 100n,
  })
  expect(candidate).toMatchObject({
    transaction,
    account: wallet,
    network: 'mainnet',
    execution: { requestId: 'request-1' },
    review: {
      fields: expect.arrayContaining([
        { label: 'Minimum receive', value: '0.12 SOL' },
      ]),
    },
  })
  expect(calls[1]!.searchParams.get('taker')).toBe(wallet)
  expect(calls[1]!.searchParams.get('excludeRouters')).toBe('jupiterz')
})

test('shared Jupiter operation rejects unsupported signing or expiry policies', async () => {
  const { wallet: _wallet, ...arguments_ } = input
  for (const overrides of [
    { signatureFeePayer: usdc },
    { transaction: wire(wallet, usdc) },
    { lastValidBlockHeight: null },
    { lastValidBlockHeight: '99' },
    { otherAmountThreshold: null },
  ]) {
    const { options } = reader({ signatureFeePayer: wallet, ...overrides })
    await expect(
      jupiterSwapTool.transaction.build(arguments_, wallet, {
        ...options,
        network: 'mainnet',
        blockHeight: async () => 100n,
      }),
    ).rejects.toThrow()
  }
})

test('swap preparation excludes RFQ routes', async () => {
  const { client, calls } = reader()
  expect(await client.prepareSwap(input)).toMatchObject({
    ok: true,
    result: { data: { transaction, requestId: 'request-1' } },
  })
  expect(calls[1]!.searchParams.get('excludeRouters')).toBe('jupiterz')
  expect(
    await reader({ router: 'jupiterz' }).client.prepareSwap(input),
  ).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
  expect(
    await client.prepareSwap({ ...input, wallet: 'invalid' }),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(calls).toHaveLength(2)
})

test('build uses the existing order API, exact units and original unsigned transaction', async () => {
  const { client, calls } = reader()
  const outcome = await client.prepareSwap(input)
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) throw new Error(outcome.error.message)
  const data = outcome.result.data
  expect(data).toMatchObject({
    wallet,
    transaction,
    requestId: 'request-1',
    lastValidBlockHeight: '9007199254740993',
    expireAt: null,
    inputAmount: { decimal: '10.000001', baseUnits: '10000001', decimals: 6 },
    expectedOutput: { decimal: '0.123456789' },
    minimumOutput: { decimal: '0.12' },
    constraints: { satisfied: true },
    fees: { feeBps: 2, platformFee: { feeMint: usdc } },
  })
  expect(calls).toHaveLength(2)
  expect(Object.fromEntries(calls[1]!.searchParams)).toEqual({
    inputMint: usdc,
    outputMint: sol,
    amount: '10000001',
    swapMode: 'ExactIn',
    slippageBps: '50',
    taker: wallet,
    maxSupportedTransactionVersion: '0',
    excludeRouters: 'jupiterz',
  })
  expect(
    getTransactionDecoder().decode(getBase64Encoder().encode(transaction))
      .signatures[address(wallet)],
  ).toBeNull()
  expect(outcome.result.warnings.join(' ')).toContain('preparation only')
  expect(outcome.result.warnings.join(' ')).not.toContain('quote only')
  if (!('providerQuote' in data)) throw new Error('Missing quote data')
  expect(JSON.stringify(data.providerQuote)).not.toContain('transaction')
  expect(JSON.stringify(data.routePlan)).not.toContain('nested-payload')
})

test('build rejects unusable transaction, wallet and expiry responses without exposing provider bodies', async () => {
  const signed = new Uint8Array(getBase64Encoder().encode(transaction))
  signed[1] = 1
  for (const overrides of [
    { transaction: null },
    { transaction: '' },
    { transaction: 'secret provider payload' },
    { transaction: getBase64Decoder().decode(new Uint8Array(20)) },
    { transaction: wire(usdc) },
    { transaction: wire(wallet, wallet, 'legacy') },
    { transaction: getBase64Decoder().decode(signed) },
    {
      transaction: getBase64Decoder().decode(
        new Uint8Array([...getBase64Encoder().encode(transaction), 0]),
      ),
    },
    { requestId: '' },
    { router: null },
    { taker: usdc },
    { lastValidBlockHeight: 123 },
    { lastValidBlockHeight: '-1' },
    { expireAt: 'invalid' },
  ]) {
    const outcome = await reader(overrides).client.prepareSwap(input)
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'upstream_unavailable', retryable: false },
    })
    expect(JSON.stringify(outcome)).not.toContain('secret')
  }
})

test('build enforces requested constraints, echoed inputs and exact amount precision', async () => {
  for (const overrides of [
    { slippageBps: 51 },
    { otherAmountThreshold: '119999999' },
    { slippageBps: null },
    { otherAmountThreshold: null },
    { inAmount: '1' },
    { inputMint: sol },
    { outputMint: usdc },
    { swapMode: 'ExactOut' },
  ])
    expect(await reader(overrides).client.prepareSwap(input)).toMatchObject({
      ok: false,
    })
  for (const amount of ['10.0000001', '18446744073709551616']) {
    const { client, calls } = reader()
    expect(await client.prepareSwap({ ...input, amount })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(calls).toHaveLength(1)
  }
  const { client, calls } = reader({ inAmount: '9007199254740993' }, 0)
  expect(
    await client.prepareSwap({
      inputMint: usdc,
      outputMint: sol,
      amount: '9007199254740993',
      wallet,
    }),
  ).toMatchObject({
    ok: true,
    result: {
      data: {
        inputAmount: { baseUnits: '9007199254740993' },
        constraints: { satisfied: null },
      },
    },
  })
  expect(calls[1]!.searchParams.has('slippageBps')).toBe(false)
})

test('build input rejects wallet, network and execution overrides before fetching', async () => {
  let calls = 0
  const options = {
    apiKey: 'test-key',
    fetch: async () => {
      calls++
      return Response.json({})
    },
  }
  for (const each of [
    { ...input, wallet: 'invalid' },
    { ...input, inputMint: sol },
    { ...input, network: 'devnet' },
    { ...input, rpcUrl: 'https://untrusted.example' },
    { ...input, receiver: usdc },
    { ...input, execution: 'embedded' },
    { ...input, amount: '1e6' },
  ])
    expect(await new JupiterClient(options).prepareSwap(each)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  expect(calls).toBe(0)
})

test('an order refusal returns a safe error instead of an empty transaction', async () => {
  const outcome = await reader({
    router: 'okx',
    errorCode: 1,
    errorMessage: 'private provider diagnostic',
    transaction: '',
  }).client.prepareSwap(input)
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: 'no_route', retryable: false },
  })
  expect(JSON.stringify(outcome)).not.toContain('private provider diagnostic')
})
