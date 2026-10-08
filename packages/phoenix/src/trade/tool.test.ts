import { address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { z } from 'zod'
import { PhoenixError } from '../client'
import { WALLET, phoenixInstruction } from './fixtures'
import { defineTradeTool, runTradeTool } from './tool'
import type { TradeRpc } from './transaction'
import type { PreparedInstructions } from './tool'

const BLOCKHASH = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR'

function fakeRpc() {
  const calls: string[] = []
  const answers: Record<string, () => unknown> = {
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 10_000n, logs: [] },
    }),
  }
  const rpc = new Proxy(
    {},
    {
      get: (_, method: string) => () => ({
        send: async () => {
          calls.push(method)
          const answer = answers[method]
          if (!answer) throw new Error(`unexpected RPC call ${method}`)
          return answer()
        },
      }),
    },
  ) as TradeRpc
  return { rpc, calls }
}

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }

function tool(prepare: () => Promise<PreparedInstructions>) {
  return defineTradeTool({
    name: 'phoenix_test',
    title: 'Test',
    description: 'Test tool',
    input: z.object({ size: z.string() }),
    prepare,
  })
}

const prepared = (instructions = [phoenixInstruction()]) => ({
  wallet: WALLET,
  instructions,
  summary: 'Buy 0.1 SOL',
  details: { size: '0.1' },
  warnings: [],
})

test('a tool result is checked, simulated and returned unsigned', async () => {
  const { rpc, calls } = fakeRpc()
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
      submit: { via: 'rpc' },
    },
  })
  expect(outcome.ok && 'instructions' in outcome.result).toBe(false)
  expect(calls).toEqual(['getLatestBlockhash', 'simulateTransaction'])
})

test('invalid input never reaches the tool', async () => {
  const { rpc, calls } = fakeRpc()
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
  const { rpc, calls } = fakeRpc()
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
  const { rpc } = fakeRpc()
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
