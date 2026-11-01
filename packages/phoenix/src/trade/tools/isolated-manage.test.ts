import { describe, expect, test } from 'bun:test'
import { isWritableRole } from '@solana/kit'
import type { Instruction } from '@solana/kit'
import bundles from '../fixtures/phoenix-bundles.json'
import {
  BLOCKHASH,
  KEYS,
  SOL_BOOK,
  SOL_MARKET,
  TRADER_ACCOUNT_DATA,
  WALLET,
  accountInfo,
  fakePhoenix,
  fakeRpc,
  marketOrderData,
} from '../fixtures'
import {
  PHOENIX_PROGRAM,
  cancelData,
  decodeBundleStep,
  decodeOrder,
  toInstruction,
  traderAccountAddress,
} from '../rise'
import type { PhoenixOrders } from '../rise'
import { runTradeTool } from '../tool'
import type { TradeOutcome } from '../tool'
import { messageOf } from '../transaction'
import { addIsolatedMargin } from './add-margin'
import { cancelOrders } from './cancel'
import { closePosition } from './close'

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }
const CROSS = await traderAccountAddress(WALLET)
const STONK = bundles.markets.STONK
const { subaccount: CHILD_INDEX } = bundles.closeMeta
const CHILD = await traderAccountAddress(WALLET, CHILD_INDEX)
const STATE = `/v1/trader/state/${WALLET}`

/** STONK's book: best ask $0.12755, best bid $0.12745. */
const STONK_BOOK = {
  symbol: 'STONK',
  mid: 0.1275,
  bids: [[0.12745, 500]],
  asks: [[0.12755, 500]],
}

const position = (symbol: string, basePositionLots: string) => ({
  symbol,
  basePositionLots,
})

const order = (id: string, change: string | null = null) => ({
  orderSequenceNumber: id,
  priceTicks: '12000',
  priceUsd: '0.12',
  side: 'bid',
  sizeRemainingLots: '10',
  change,
})

type Row = {
  index: number
  collateral?: string
  positions?: ReturnType<typeof position>[]
  orders?: Record<string, ReturnType<typeof order>[]>
}

/** Phoenix's trader state, one row per subaccount. */
const trader = (...rows: Row[]) => ({
  authority: WALLET,
  snapshot: {
    subaccounts: rows.map((row) => ({
      subaccountIndex: row.index,
      collateral: row.collateral ?? '0',
      positions: row.positions ?? [],
      orders: Object.entries(row.orders ?? {}).map(([symbol, orders]) => ({
        symbol,
        orders,
      })),
    })),
  },
})

/**
 * Phoenix's real close bundle, with the order restated from the request the
 * way the server does.
 */
const serverClose = (
  request: Parameters<PhoenixOrders['placeIsolatedMarketOrder']>[0],
): Instruction[] =>
  bundles.close.map(toInstruction).map((instruction) =>
    decodeBundleStep(Uint8Array.from(instruction.data ?? []))?.kind === 'order'
      ? {
          ...instruction,
          data: marketOrderData({
            buy: request.side === 'buy',
            priceInTicks: BigInt(request.maxPriceInTicks ?? 0),
            lots: BigInt(request.numBaseLots ?? 0),
            minLots: BigInt(request.minBaseLotsToFill ?? 0),
            lastValidSlot: null,
            reduceOnly: request.isReduceOnly ?? false,
          }),
        }
      : instruction,
  )

function fakeOrders(build: typeof serverClose = serverClose) {
  const requests: unknown[] = []
  const unused = () => {
    throw new Error('unexpected Phoenix order route')
  }
  const orders: PhoenixOrders = {
    placeIsolatedMarketOrder: async (request) => {
      requests.push(request)
      return build(request)
    },
    placeIsolatedLimitOrder: unused,
    placePositionConditionalOrder: unused,
    cancelConditionalOrder: unused,
  }
  return { orders, requests }
}

function opts(state: unknown, orders = fakeOrders().orders) {
  const { rpc } = fakeRpc({
    getSlot: () => 1_000n,
    getAccountInfo: (account) =>
      account === CROSS
        ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
        : { value: null },
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 300_000n, logs: [] },
    }),
  })
  return {
    rpc,
    fees: FEES,
    orders,
    fetch: fakePhoenix({
      '/v1/view/exchange/market/STONK': STONK,
      '/v1/view/orderbook/STONK': STONK_BOOK,
      '/v1/view/exchange/keys': bundles.keys,
      [STATE]: state,
    }).fetch,
  }
}

function ready(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  return outcome.result
}

/** A ready result's Phoenix instructions, without the compute budget. */
function phoenixSteps(outcome: TradeOutcome) {
  return messageOf(ready(outcome).transaction).instructions.filter(
    (instruction) => instruction.programAddress === PHOENIX_PROGRAM,
  )
}

const kinds = (steps: readonly Instruction[]) =>
  steps.map(
    (step) => decodeBundleStep(Uint8Array.from(step.data ?? []))?.kind ?? null,
  )

const writes = (instruction: Instruction | undefined, account: string) =>
  (instruction?.accounts ?? []).some(
    (each) => each.address === account && isWritableRole(each.role),
  )

const isolatedShort = (lots = '-7') =>
  trader(
    { index: 0, collateral: '10000000' },
    { index: CHILD_INDEX, positions: [position('STONK', lots)] },
  )

describe('closing an isolated position', () => {
  const close = (input: Record<string, unknown>, state: unknown) =>
    runTradeTool(
      closePosition,
      { wallet: WALLET, symbol: 'STONK', ...input },
      opts(state),
    )

  test('all of it is a reduce-only order on that subaccount, then sweeps', async () => {
    const outcome = await close({ limitPrice: '0.12972' }, isolatedShort())
    const steps = phoenixSteps(outcome)
    expect(kinds(steps)).toEqual(['order', 'sweep_usdc', 'sweep_sol'])
    expect(writes(steps[0], CHILD)).toBe(true)
    expect(decodeOrder(Uint8Array.from(steps[0]?.data ?? []))).toMatchObject({
      side: 'buy',
      numBaseLots: 7n,
      priceInTicks: 12972n,
      reduceOnly: true,
      cancelExisting: false,
    })
    const result = ready(outcome)
    expect(result).toMatchObject({
      position: {
        symbol: 'STONK',
        assetId: STONK.assetId,
        baseLotsDecimals: 0,
        subaccount: CHILD_INDEX,
      },
      summary:
        'Close 7 of the 7 STONK isolated short (subaccount 1): market buy now, paying at most $0.12972 each; reduce-only, so it can never open a long',
      details: {
        position: 'short 7',
        closing: '7',
        subaccount: '1',
        reduceOnly: 'true',
      },
      trade: {
        action: 'close',
        closing: 'short',
        side: 'buy',
        size: '7',
        worstPrice: '0.12972',
        reduceOnly: true,
        marginMode: 'isolated',
        subaccount: CHILD_INDEX,
      },
    })
    expect(result.expiresAfterSlot).toBeDefined()
    expect(result.warnings[0]).toContain(
      'its collateral returns to your cross-margin account in the same transaction',
    )
  })

  test('the second position in one market is reachable', async () => {
    const second = 9
    const outcome = await close(
      { limitPrice: '0.12972', subaccount: second },
      trader(
        { index: CHILD_INDEX, positions: [position('STONK', '-7')] },
        { index: second, positions: [position('STONK', '-2')] },
      ),
    )
    const [closing] = phoenixSteps(outcome)
    expect(writes(closing, await traderAccountAddress(WALLET, second))).toBe(
      true,
    )
    expect(writes(closing, CHILD)).toBe(false)
  })

  test('two isolated positions in one market need a subaccount', async () => {
    expect(
      await close(
        { maxSlippageBps: 100 },
        trader(
          { index: CHILD_INDEX, positions: [position('STONK', '-7')] },
          { index: 9, positions: [position('STONK', '-2')] },
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  test('part of it closes that share, at a limit from the book', async () => {
    const outcome = await close(
      { fraction: 0.5, maxSlippageBps: 100 },
      isolatedShort(),
    )
    // Half of 7 lots rounds down to 3; the buy limit is above the best ask.
    const [step] = phoenixSteps(outcome)
    expect(decodeOrder(Uint8Array.from(step?.data ?? []))).toMatchObject({
      numBaseLots: 3n,
      priceInTicks: 12882n,
      reduceOnly: true,
    })
    expect(ready(outcome).details).toMatchObject({ closing: '3' })
  })

  test('a long is closed by a sell', async () => {
    const outcome = await close({ limitPrice: '0.125' }, isolatedShort('7'))
    expect(ready(outcome).trade).toMatchObject({
      side: 'sell',
      closing: 'long',
    })
  })

  test('a limit out of reach says it will not fill', async () => {
    const outcome = await close({ limitPrice: '0.12' }, isolatedShort())
    expect(ready(outcome).warnings).toContainEqual(
      'The limit is below the best ask (0.12755), so this order will not fill now.',
    )
  })

  test('a position in both cross and isolated needs a subaccount', async () => {
    const both = trader(
      { index: 0, positions: [position('STONK', '5')] },
      { index: CHILD_INDEX, positions: [position('STONK', '-7')] },
    )
    expect(await close({ maxSlippageBps: 100 }, both)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          'STONK is open in subaccounts 0 and 1; pass subaccount from phoenix_get_account',
      },
    })
    const [closing] = phoenixSteps(
      await close({ subaccount: CHILD_INDEX, maxSlippageBps: 100 }, both),
    )
    expect(writes(closing, CHILD)).toBe(true)
  })

  test('without a position there is nothing to close', async () => {
    const none = trader({ index: 0 }, { index: CHILD_INDEX })
    for (const input of [{}, { subaccount: CHILD_INDEX }])
      expect(
        await close({ ...input, maxSlippageBps: 100 }, none),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'not_found',
          message: 'This account has no open STONK position',
        },
      })
    // The position lives elsewhere: a subaccount that holds none is not it.
    expect(
      await close({ subaccount: 2, maxSlippageBps: 100 }, isolatedShort()),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})

describe('closing a cross position stays as it was', () => {
  const cross = (input: Record<string, unknown>, state: unknown) => {
    const { orders, requests } = fakeOrders()
    const { rpc } = fakeRpc({
      getAccountInfo: (account) =>
        account === CROSS
          ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
          : { value: null },
      getSlot: () => 1_000n,
      getLatestBlockhash: () => ({
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
      }),
      simulateTransaction: () => ({
        value: { err: null, unitsConsumed: 300_000n, logs: [] },
      }),
    })
    return {
      requests,
      run: runTradeTool(
        closePosition,
        { wallet: WALLET, symbol: 'SOL', ...input },
        {
          rpc,
          fees: FEES,
          orders,
          fetch: fakePhoenix({
            '/v1/view/exchange/market/SOL': SOL_MARKET,
            '/v1/view/orderbook/SOL': SOL_BOOK,
            '/v1/view/exchange/keys': KEYS,
            [STATE]: state,
          }).fetch,
        },
      ),
    }
  }

  test('with or without subaccount 0: our own order, with an expiry', async () => {
    const state = trader({ index: 0, positions: [position('SOL', '25')] })
    for (const input of [{}, { subaccount: 0 }]) {
      const { run, requests } = cross({ ...input, maxSlippageBps: 50 }, state)
      const outcome = await run
      expect(requests).toEqual([])
      const steps = phoenixSteps(outcome)
      expect(steps).toHaveLength(1)
      expect(decodeOrder(Uint8Array.from(steps[0]?.data ?? []))).toMatchObject({
        side: 'sell',
        numBaseLots: 25n,
        reduceOnly: true,
        lastValidSlot: 1_150n,
      })
      expect(ready(outcome)).toMatchObject({
        expiresAfterSlot: '1150',
        position: { symbol: 'SOL', assetId: 0, baseLotsDecimals: 2 },
      })
      expect(ready(outcome).trade.marginMode).toBeUndefined()
    }
  })

  test('cross and isolated in one market, picking cross', async () => {
    const state = trader(
      { index: 0, positions: [position('SOL', '25')] },
      { index: 4, positions: [position('SOL', '-3')] },
    )
    const { run, requests } = cross(
      { subaccount: 0, maxSlippageBps: 50 },
      state,
    )
    expect(phoenixSteps(await run)).toHaveLength(1)
    expect(requests).toEqual([])
  })

  test('a position can always be closed, even if its market went isolated-only', async () => {
    expect(
      await runTradeTool(
        closePosition,
        { wallet: WALLET, symbol: 'STONK', maxSlippageBps: 50 },
        opts(trader({ index: 0, positions: [position('STONK', '5')] })),
      ),
    ).toMatchObject({ ok: true, result: { status: 'ready' } })
  })
})

describe('cancelling isolated orders', () => {
  const cancel = (input: Record<string, unknown>, state: unknown) =>
    runTradeTool(
      cancelOrders,
      { wallet: WALLET, symbol: 'STONK', ...input },
      opts(state),
    )

  test('the last order of a flat subaccount sweeps it back to cross', async () => {
    const outcome = await cancel(
      {},
      trader(
        { index: 0 },
        { index: 2, orders: { STONK: [order('7'), order('8', 'closed')] } },
      ),
    )
    const steps = phoenixSteps(outcome)
    expect(kinds(steps.slice(1))).toEqual(['sweep_usdc', 'sweep_sol'])
    const child = await traderAccountAddress(WALLET, 2)
    expect(Uint8Array.from(steps[0]?.data ?? [])).toEqual(cancelData(null))
    expect(writes(steps[0], child)).toBe(true)
    for (const sweep of steps.slice(1)) {
      expect(writes(sweep, child)).toBe(true)
      expect(writes(sweep, CROSS)).toBe(true)
    }
    expect(ready(outcome)).toMatchObject({
      summary: 'Cancel all 1 resting STONK order in isolated subaccount 2',
      details: { subaccount: '2', 'order 7': 'bid 10 at $0.12' },
      trade: { cancelled: 1, marginMode: 'isolated', subaccount: 2 },
      warnings: [
        'This cancels every resting order the account has in this market when it lands, including any placed after this was prepared.',
        'This empties the isolated subaccount, so its collateral returns to your cross-margin account in the same transaction. If the subaccount is no longer empty when this lands, the collateral stays there.',
      ],
    })
  })

  test('cancelling every order by ID also sweeps', async () => {
    const outcome = await cancel(
      { orderIds: ['7', '9'] },
      trader({
        index: 2,
        orders: { STONK: [order('7'), order('9')] },
      }),
    )
    const [first, ...rest] = phoenixSteps(outcome)
    expect(Uint8Array.from(first?.data ?? [])).toEqual(
      cancelData([
        { priceInTicks: 12000n, orderSequenceNumber: 7n },
        { priceInTicks: 12000n, orderSequenceNumber: 9n },
      ]),
    )
    expect(kinds(rest)).toEqual(['sweep_usdc', 'sweep_sol'])
    expect(ready(outcome).summary).toBe(
      'Cancel 2 resting STONK orders in isolated subaccount 2',
    )
  })

  test('no sweep while the subaccount keeps a position or an order', async () => {
    for (const [input, state] of [
      // A position stays.
      [
        {},
        trader({
          index: 2,
          positions: [position('STONK', '4')],
          orders: { STONK: [order('7')] },
        }),
      ],
      // Another order in this market stays.
      [
        { orderIds: ['7'] },
        trader({
          index: 2,
          orders: { STONK: [order('7'), order('9')] },
        }),
      ],
      // An order in another market stays.
      [
        {},
        trader({
          index: 2,
          orders: { STONK: [order('7')], GOLD: [order('11')] },
        }),
      ],
    ] as const) {
      const outcome = await cancel(input, state)
      expect(phoenixSteps(outcome)).toHaveLength(1)
      expect(JSON.stringify(ready(outcome).warnings)).not.toContain(
        'empties the isolated subaccount',
      )
    }
  })

  test('cross orders are cancelled in cross, and never swept', async () => {
    const orders = { STONK: [order('7')] }
    for (const input of [{}, { subaccount: 0 }]) {
      const outcome = await cancel(
        input,
        trader({ index: 0, orders }, { index: 2 }),
      )
      const steps = phoenixSteps(outcome)
      expect(steps).toHaveLength(1)
      expect(writes(steps[0], CROSS)).toBe(true)
      expect(ready(outcome)).toMatchObject({
        summary: 'Cancel all 1 resting STONK order in the cross-margin account',
      })
      expect(ready(outcome).details).toEqual({
        'order 7': 'bid 10 at $0.12',
      })
      expect(ready(outcome).trade.subaccount).toBeUndefined()
    }
  })

  test('orders in both need a subaccount', async () => {
    const orders = { STONK: [order('7')] }
    const state = trader({ index: 0, orders }, { index: 2, orders })
    expect(await cancel({}, state)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message:
          'STONK has resting orders in subaccounts 0 and 2; pass subaccount from phoenix_get_account',
      },
    })
    expect(
      await cancel({}, trader({ index: 2, orders }, { index: 5, orders })),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('2 and 5'),
      },
    })
    const child = await traderAccountAddress(WALLET, 2)
    const steps = phoenixSteps(await cancel({ subaccount: 2 }, state))
    expect(writes(steps[0], child)).toBe(true)
    expect(writes(steps[0], CROSS)).toBe(false)
  })

  test('a subaccount without orders has nothing to cancel', async () => {
    expect(
      await cancel(
        { subaccount: 3 },
        trader({ index: 2, orders: { STONK: [order('7')] } }, { index: 3 }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: 'This account has no resting STONK orders',
      },
    })
  })

  test('an order ID of another subaccount is not found', async () => {
    expect(
      await cancel(
        { orderIds: ['99'], subaccount: 2 },
        trader(
          { index: 0, orders: { STONK: [order('99')] } },
          { index: 2, orders: { STONK: [order('7')] } },
        ),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: 'No resting STONK order 99; open order IDs: 7',
      },
    })
  })
})

describe('adding margin', () => {
  const add = (input: Record<string, unknown>, state: unknown) =>
    runTradeTool(
      addIsolatedMargin,
      { wallet: WALLET, symbol: 'STONK', amount: '2.5', ...input },
      opts(state),
    )

  test('moves the amount from cross to the subaccount', async () => {
    const outcome = await add({}, isolatedShort())
    const steps = phoenixSteps(outcome)
    expect(kinds(steps)).toEqual(['sync', 'transfer_usdc'])
    const [, transfer] = steps
    expect(decodeBundleStep(Uint8Array.from(transfer?.data ?? []))).toEqual({
      kind: 'transfer_usdc',
      amount: 2_500_000n,
    })
    expect(transfer?.accounts?.[4]?.address).toBe(CROSS)
    expect(transfer?.accounts?.[5]?.address).toBe(CHILD)
    expect(ready(outcome)).toMatchObject({
      summary:
        'Add 2.5 USDC of margin to the isolated 7 STONK short (subaccount 1), from the cross-margin account',
      details: {
        position: 'short 7',
        subaccount: '1',
        collateralUsdc: '2.5',
        crossCollateralUsdc: '10',
      },
      trade: {
        action: 'add_margin',
        symbol: 'STONK',
        marginMode: 'isolated',
        subaccount: CHILD_INDEX,
        collateralUsdc: '2.5',
      },
      warnings: [
        "Losses are limited to this position's collateral, and it can be liquidated while your cross account still holds funds.",
        'This margin cannot be taken back out while the position is open.',
      ],
    })
  })

  test('all of the cross collateral is enough', async () => {
    ready(await add({ amount: '10' }, isolatedShort()))
  })

  test('a cross position takes no added margin', async () => {
    expect(
      await add(
        { subaccount: 0 },
        trader({
          index: 0,
          collateral: '10000000',
          positions: [position('STONK', '5')],
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('only an isolated position'),
      },
    })
  })

  test('low cross collateral points at phoenix_deposit', async () => {
    expect(await add({ amount: '10.000001' }, isolatedShort())).toMatchObject({
      ok: false,
      error: {
        code: 'insufficient_funds',
        message:
          'The cross-margin account holds 10 USDC of collateral, less than 10.000001; add more with phoenix_deposit',
      },
    })
  })

  test('no position, or an ambiguous one', async () => {
    expect(await add({}, trader({ index: 0 }))).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
    const both = trader(
      { index: 0, positions: [position('STONK', '5')] },
      { index: CHILD_INDEX, positions: [position('STONK', '-7')] },
    )
    expect(await add({}, both)).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('0 and 1'),
      },
    })
  })

  test('an amount must be positive, with at most 6 decimals', async () => {
    for (const amount of ['0', '-1', '0.0000001'])
      expect(await add({ amount }, isolatedShort())).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
  })
})
