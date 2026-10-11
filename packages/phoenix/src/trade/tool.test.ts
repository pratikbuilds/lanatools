import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type { Address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import { PhoenixError } from '../client'
import {
  BLOCKHASH,
  OTHER,
  WALLET,
  fakeRpc,
  phoenixInstruction,
} from './fixtures'
import { defineTradeTool, runTradeTool } from './tool'
import type { Prepared } from './tool'

const rpcFor = () =>
  fakeRpc({
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 10_000n, logs: [] },
    }),
  })

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }

function tool(prepare: () => Promise<Prepared>) {
  return defineTradeTool({
    name: 'phoenix_test',
    title: 'Test',
    description: 'Test tool',
    arguments: z.object({ size: z.string() }),
    prepare,
  })
}

const prepared = (instructions = [phoenixInstruction()]): Prepared => ({
  kind: 'instructions',
  wallet: WALLET,
  instructions,
  summary: 'Buy 0.1 SOL',
  details: { size: '0.1' },
  trade: { kind: 'perp', venue: 'phoenix', action: 'order', size: '0.1' },
  warnings: [],
})

test('a tool result is checked, simulated and returned unsigned', async () => {
  const { rpc, calls } = rpcFor()
  const outcome = await runTradeTool(
    tool(async () => prepared()),
    { wallet: WALLET, size: '0.1' },
    { rpc, fees: FEES },
  )
  expect(outcome).toMatchObject({
    ok: true,
    result: {
      wallet: WALLET,
      summary: 'Buy 0.1 SOL',
      details: { size: '0.1' },
      warnings: [],
      lastValidBlockHeight: '500',
      simulation: { ok: true, computeUnits: 10_000 },
      status: 'ready',
      submit: { via: 'rpc' },
    },
  })
  expect(outcome.ok && 'instructions' in outcome.result).toBe(false)
  expect(calls.map(([method]) => method)).toEqual([
    'getLatestBlockhash',
    'simulateTransaction',
  ])
})

test('invalid input never reaches the tool', async () => {
  const { rpc, calls } = rpcFor()
  let reached = false
  const outcome = await runTradeTool(
    tool(async () => {
      reached = true
      throw new Error('unreachable')
    }),
    { size: 1 },
    { rpc, fees: FEES },
  )
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: 'invalid_input', retryable: false },
  })
  expect(reached).toBe(false)
  expect(calls).toEqual([])
})

test('instructions that fail the checks are never simulated', async () => {
  const { rpc, calls } = rpcFor()
  const system = address('11111111111111111111111111111111')
  const outcome = await runTradeTool(
    tool(async () =>
      prepared([phoenixInstruction(undefined, { program: system })]),
    ),
    { wallet: WALLET, size: '0.1' },
    { rpc, fees: FEES },
  )
  expect(outcome).toMatchObject({ ok: false, error: { code: 'check_failed' } })
  expect(calls).toEqual([])
})

test('Phoenix errors pass through; anything else becomes a safe error', async () => {
  const { rpc } = rpcFor()
  expect(
    await runTradeTool(
      tool(async () => {
        throw new PhoenixError('not_activated', 'Activate first')
      }),
      { wallet: WALLET, size: '0.1' },
      { rpc, fees: FEES },
    ),
  ).toEqual({
    ok: false,
    error: {
      code: 'not_activated',
      message: 'Activate first',
      retryable: false,
    },
  })

  const logged = console.error
  console.error = () => {}
  try {
    expect(
      await runTradeTool(
        tool(async () => {
          throw new Error('https://rpc.example/?api-key=secret')
        }),
        { wallet: WALLET, size: '0.1' },
        { rpc, fees: FEES },
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'upstream_error',
        message: 'Could not prepare the Phoenix transaction',
        retryable: false,
      },
    })
  } finally {
    console.error = logged
  }
})

test('a failed simulation leaves nothing to sign and says why', async () => {
  const { rpc } = fakeRpc({
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: {
        err: { InstructionError: [1, 'InvalidInstructionData'] },
        unitsConsumed: 1_000n,
        logs: ['Program log: IOC order does not meet minimum requirements.'],
      },
    }),
  })
  const outcome = await runTradeTool(
    tool(async () => prepared()),
    { wallet: WALLET, size: '0.1' },
    { rpc, fees: FEES },
  )
  expect(outcome).toEqual({
    ok: true,
    result: {
      status: 'simulation_failed',
      wallet: WALLET,
      summary: 'Buy 0.1 SOL',
      details: { size: '0.1' },
      trade: { kind: 'perp', venue: 'phoenix', action: 'order', size: '0.1' },
      warnings: [],
      simulation: {
        ok: false,
        computeUnits: 1_000,
        error:
          '{"InstructionError":[1,"InvalidInstructionData"]}: IOC order does not meet minimum requirements.',
        logs: ['Program log: IOC order does not meet minimum requirements.'],
      },
    },
  })
})

/** An unsigned transaction paid by `feePayer`, as Rise builds activation. */
function prebuilt(
  feePayer: Address = WALLET,
  instruction = phoenixInstruction(),
) {
  return getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(feePayer, message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
            message,
          ),
        (message) =>
          appendTransactionMessageInstructions([instruction], message),
      ),
    ),
  )
}

const whole = (transaction: string): Prepared => ({
  kind: 'transaction',
  wallet: WALLET,
  transaction: getBase64EncodedWireTransaction(
    getTransactionDecoder().decode(getBase64Encoder().encode(transaction)),
  ),
  lastValidBlockHeight: '500',
  coSigners: [],
  submit: { via: 'rpc' },
  summary: 'Activate',
  details: {},
  trade: { kind: 'perp', venue: 'phoenix', action: 'activate' },
  warnings: [],
})

test('a whole transaction is checked, then simulated exactly as built', async () => {
  const { rpc, calls } = rpcFor()
  const transaction = prebuilt()
  const outcome = await runTradeTool(
    tool(async () => whole(transaction)),
    { wallet: WALLET, size: '0.1' },
    { rpc, fees: FEES },
  )
  expect(outcome).toMatchObject({
    ok: true,
    result: { status: 'ready', transaction, lastValidBlockHeight: '500' },
  })
  // No compute budget is added and no new blockhash is fetched.
  expect(calls.map(([method, [wire]]) => [method, wire])).toEqual([
    ['simulateTransaction', transaction],
  ])
})

test('a whole transaction someone else pays for, or with another signer, is never simulated', async () => {
  for (const transaction of [
    prebuilt(OTHER),
    prebuilt(WALLET, phoenixInstruction(undefined, { signers: [OTHER] })),
  ]) {
    const { rpc, calls } = rpcFor()
    expect(
      await runTradeTool(
        tool(async () => whole(transaction)),
        { wallet: WALLET, size: '0.1' },
        { rpc, fees: FEES },
      ),
    ).toMatchObject({ ok: false, error: { code: 'check_failed' } })
    expect(calls).toEqual([])
  }
})
