import { address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import { PhoenixError } from '../client'
import { BLOCKHASH, WALLET, fakeRpc, phoenixInstruction } from './fixtures'
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
    input: z.object({ size: z.string() }),
    prepare,
  })
}

const prepared = (instructions = [phoenixInstruction()]): Prepared => ({
  kind: 'instructions',
  wallet: WALLET,
  instructions,
  summary: 'Buy 0.1 SOL',
  details: { size: '0.1' },
  warnings: [],
})

test('a tool result is checked, simulated and returned unsigned', async () => {
  const { rpc, calls } = rpcFor()
  const outcome = await runTradeTool(
    tool(async () => prepared()),
    { size: '0.1' },
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
    { size: '0.1' },
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
      { size: '0.1' },
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
        { size: '0.1' },
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
