import { describe, expect, test } from 'bun:test'
import {
  BLOCKHASH,
  KEYS,
  SOL_BOOK,
  SOL_MARKET,
  TRADER_ACCOUNT_DATA,
  WALLET,
  accountInfo,
  conditionalAccountData,
  fakeOrders,
  fakePhoenix,
  fakeRpc,
} from '../fixtures'
import type { FakeSlot } from '../fixtures'
import {
  PHOENIX_PROGRAM,
  conditionalOrdersAddress,
  decodeBundleStep,
  traderAccountAddress,
} from '../rise'
import type { TriggerPacket } from '../rise'
import { runTradeTool } from '../tool'
import type { TradeOutcome } from '../tool'
import { messageOf } from '../transaction'
import { cancelTpsl } from './cancel-tpsl'
import { marketOrder } from './market-order'
import { setTpsl } from './set-tpsl'
import { checkAgainstMark, positionLegs, tpslTerms } from './tpsl'

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }
const CROSS = await traderAccountAddress(WALLET)
const ISOLATED = await traderAccountAddress(WALLET, 3)
const UNITS = { tickSize: 100n, baseLotsDecimals: 2 }

/** Mark 115.15 is 11515 ticks. */
const STATS = {
  markets: [
    {
      symbol: 'SOL',
      timestamp_ms: '1',
      mark_price: 115.15,
      oracle_price: 115.15,
      prev_day_mark_price: 115,
      open_interest: 1,
      day_volume_usd: 1,
      current_funding_rate: 0,
      eight_hour_funding_rate: 0,
      annualized_funding_rate: 0,
    },
  ],
}

type World = {
  cross?: string
  isolated?: string
  crossSlots?: FakeSlot[] | null
  isolatedSlots?: FakeSlot[] | null
  stats?: unknown
}

const state = ({ cross = '25', isolated = '0' }: World) => ({
  snapshot: {
    subaccounts: [
      {
        subaccountIndex: 0,
        collateral: '0',
        positions: [{ symbol: 'SOL', basePositionLots: cross }],
      },
      {
        subaccountIndex: 3,
        collateral: '0',
        positions: [{ symbol: 'SOL', basePositionLots: isolated }],
      },
    ],
  },
})

async function context(world: World, orders = fakeOrders()) {
  const accounts = new Map<string, Uint8Array>([
    [CROSS, TRADER_ACCOUNT_DATA],
    [ISOLATED, TRADER_ACCOUNT_DATA],
  ])
  const { crossSlots = null, isolatedSlots = null } = world
  if (crossSlots)
    accounts.set(
      await conditionalOrdersAddress(CROSS),
      conditionalAccountData(CROSS, crossSlots),
    )
  if (isolatedSlots)
    accounts.set(
      await conditionalOrdersAddress(ISOLATED),
      conditionalAccountData(ISOLATED, isolatedSlots),
    )
  return {
    orders: orders.orders,
    fees: FEES,
    rpc: fakeRpc({
      getAccountInfo: (account) => {
        const data = accounts.get(String(account))
        return data ? accountInfo(PHOENIX_PROGRAM, data) : { value: null }
      },
      getLatestBlockhash: () => ({
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
      }),
      simulateTransaction: () => ({
        value: { err: null, unitsConsumed: 40_000n, logs: [] },
      }),
    }).rpc,
    fetch: fakePhoenix({
      '/v1/view/exchange/market/SOL': SOL_MARKET,
      '/v1/view/exchange/keys': KEYS,
      '/v1/markets/stats/latest': world.stats ?? STATS,
      [`/v1/trader/state/${WALLET}`]: state(world),
    }).fetch,
  }
}

function ready(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  return outcome.result
}

const TP = { triggerPrice: '120', worstPrice: '119.5' }
const SL = { triggerPrice: '110', worstPrice: '105' }
const SHORT_TP = { triggerPrice: '110', worstPrice: '110.5' }
const SHORT_SL = { triggerPrice: '120', worstPrice: '125' }

const set = async (
  input: Record<string, unknown>,
  world: World = {},
  orders = fakeOrders(),
) => ({
  outcome: await runTradeTool(
    setTpsl,
    { wallet: WALLET, symbol: 'SOL', ...input },
    await context(world, orders),
  ),
  request: orders.place[0],
})

const cancel = async (
  input: Record<string, unknown>,
  world: World = {},
  orders = fakeOrders(),
) => ({
  outcome: await runTradeTool(
    cancelTpsl,
    { wallet: WALLET, symbol: 'SOL', ...input },
    await context(world, orders),
  ),
  requests: orders.cancel,
})

function steps(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  return messageOf(outcome.result.transaction)
    .instructions.slice(1)
    .map((each) => decodeBundleStep(Uint8Array.from(each.data ?? [])))
}

const refusal = (code: string, message: string) => ({
  ok: false,
  error: { code, message },
})

const leg = (
  side: TriggerPacket['side'],
  orderKind: TriggerPacket['orderKind'],
  ticks: bigint,
  worst = ticks,
) => ({
  side,
  orderKind,
  triggerPriceInTicks: ticks,
  executionPriceInTicks: worst,
})
const longSlot = (slot: number, extra: Partial<FakeSlot> = {}): FakeSlot => ({
  slot,
  sizePercent: 50,
  greater: leg('sell', 'limit', 12000n, 11950n),
  less: leg('sell', 'ioc', 11000n, 10500n),
  ...extra,
})
const shortSlot = (slot: number, extra: Partial<FakeSlot> = {}): FakeSlot => ({
  slot,
  sizeBaseLots: 10n,
  greater: leg('buy', 'ioc', 12000n, 12500n),
  less: leg('buy', 'limit', 11000n, 11050n),
  ...extra,
})

describe('tpslTerms', () => {
  const terms = (direction: 'long' | 'short') =>
    tpslTerms({
      direction,
      assetId: 0,
      units: UNITS,
      takeProfit: direction === 'long' ? TP : SHORT_TP,
      stopLoss: direction === 'long' ? SL : SHORT_SL,
      size: { sizeBaseLots: null, sizePercent: 100 },
    })

  test("a long's take profit is the greater trigger and its stop the less", () => {
    expect(terms('long')).toMatchObject({
      greaterTrigger: {
        side: 'sell',
        orderKind: 'limit',
        triggerPriceInTicks: 12000,
        executionPriceInTicks: 11950,
      },
      lessTrigger: {
        side: 'sell',
        orderKind: 'ioc',
        triggerPriceInTicks: 11000,
        executionPriceInTicks: 10500,
      },
      conditional: {
        greater: { triggerDirection: 'greater', side: 'sell' },
        less: { triggerDirection: 'less', side: 'sell' },
      },
    })
  })

  test("a short's are reversed and fire as buys", () => {
    expect(terms('short')).toMatchObject({
      greaterTrigger: {
        side: 'buy',
        orderKind: 'ioc',
        triggerPriceInTicks: 12000,
        executionPriceInTicks: 12500,
      },
      lessTrigger: {
        side: 'buy',
        orderKind: 'limit',
        triggerPriceInTicks: 11000,
        executionPriceInTicks: 11050,
      },
    })
  })

  test('a worst price rounds so it never loosens', () => {
    const worst = (direction: 'long' | 'short', worstPrice: string) =>
      tpslTerms({
        direction,
        assetId: 0,
        units: UNITS,
        stopLoss: {
          triggerPrice: direction === 'long' ? '110' : '120',
          worstPrice,
        },
        size: { sizeBaseLots: null, sizePercent: 100 },
      }).stopLoss?.executionPriceInTicks
    // A sell takes at least this, so up; a buy pays at most this, so down.
    expect(worst('long', '105.001')).toBe(10501n)
    expect(worst('short', '125.009')).toBe(12500n)
  })

  test('a leg left out is null in both forms', () => {
    const only = tpslTerms({
      direction: 'long',
      assetId: 0,
      units: UNITS,
      takeProfit: TP,
      size: { sizeBaseLots: 5n, sizePercent: null },
    })
    expect(only.lessTrigger).toBeNull()
    expect(only.conditional).toMatchObject({
      less: null,
      sizeBaseLots: 5n,
      sizePercent: null,
    })
  })

  test('a trigger at mark is refused, in ticks', () => {
    const at = tpslTerms({
      direction: 'long',
      assetId: 0,
      units: UNITS,
      takeProfit: { triggerPrice: '115.15', worstPrice: '115.15' },
      size: { sizeBaseLots: null, sizePercent: 100 },
    })
    expect(() => checkAgainstMark(at, 11515n, 'long')).toThrow(
      "A long's take profit must trigger above the mark price",
    )
    expect(() => checkAgainstMark(at, 11514n, 'long')).not.toThrow()
  })
})

describe('positionLegs', () => {
  test('names legs by what they do for the position', () => {
    const slots = [{ ...longSlot(1), ...withPackets(longSlot(1)) }]
    expect(positionLegs(slots, 0, 'long')).toMatchObject([
      {
        slot: 1,
        takeProfit: { orderKind: 'limit' },
        stopLoss: { orderKind: 'ioc' },
      },
    ])
  })

  test("drops another market's slots, and a leg that does not close it", () => {
    const slots = [
      { ...withPackets(longSlot(1)), slot: 1, assetId: 7 },
      { ...withPackets(longSlot(2)), slot: 2 },
    ]
    expect(positionLegs(slots, 0, 'long').map((each) => each.slot)).toEqual([2])
    expect(positionLegs(slots, 0, 'short')).toEqual([])
  })
})

function withPackets(slot: FakeSlot) {
  const packet = (
    value: FakeSlot['greater'],
    triggerDirection: TriggerPacket['triggerDirection'],
  ) => (value ? { ...value, triggerDirection } : null)
  return {
    slot: slot.slot,
    assetId: 0,
    sizeBaseLots: slot.sizeBaseLots ?? null,
    sizePercent: slot.sizePercent ?? null,
    greater: packet(slot.greater, 'greater'),
    less: packet(slot.less, 'less'),
  }
}

describe('phoenix_set_tpsl', () => {
  test('a long, in full, with both legs', async () => {
    const { outcome, request } = await set({
      takeProfit: TP,
      stopLoss: SL,
      percent: 100,
    })
    expect(request).toEqual({
      authority: WALLET,
      traderPdaIndex: 0,
      symbol: 'SOL',
      sizePercent: 100,
      greaterTrigger: {
        side: 'sell',
        orderKind: 'limit',
        triggerPriceInTicks: 12000,
        executionPriceInTicks: 11950,
      },
      lessTrigger: {
        side: 'sell',
        orderKind: 'ioc',
        triggerPriceInTicks: 11000,
        executionPriceInTicks: 10500,
      },
      isIsolated: false,
      traderSubaccountIndex: 0,
    })
    expect(steps(outcome)).toMatchObject([
      {
        kind: 'place_conditional',
        packet: { sizePercent: 100, sizeBaseLots: null },
      },
    ])
    expect(outcome).toMatchObject({
      result: {
        status: 'ready',
        summary: 'Set take profit and stop loss on 100% of the 0.25 SOL long',
        details: {
          position: 'long 0.25',
          takeProfit: 'trigger $120, worst $119.5',
          stopLoss: 'trigger $110, worst $105',
          size: '100% of the position, about 0.25 SOL now',
          markPrice: '115.15',
          activeTpsl: '0',
        },
        trade: {
          action: 'set_tpsl',
          symbol: 'SOL',
          side: 'sell',
          size: '0.25',
          closing: 'long',
          takeProfitPrice: '120',
          stopLossPrice: '110',
        },
      },
    })
  })

  test('a short, by percent', async () => {
    const { outcome, request } = await set(
      { takeProfit: SHORT_TP, stopLoss: SHORT_SL, percent: 50 },
      { cross: '-30' },
    )
    expect(request).toMatchObject({
      sizePercent: 50,
      greaterTrigger: { side: 'buy', orderKind: 'ioc' },
      lessTrigger: { side: 'buy', orderKind: 'limit' },
    })
    expect(outcome).toMatchObject({
      result: {
        summary: 'Set take profit and stop loss on 50% of the 0.3 SOL short',
        details: { size: '50% of the position, about 0.15 SOL now' },
        trade: { side: 'buy', closing: 'short' },
      },
    })
  })

  test('a fixed size goes as base lots', async () => {
    const { outcome, request } = await set({ takeProfit: TP, size: '0.1' })
    expect(request).toMatchObject({ numBaseLots: 10, lessTrigger: null })
    expect(request).not.toHaveProperty('sizePercent')
    expect(steps(outcome)).toMatchObject([
      {
        kind: 'place_conditional',
        packet: { sizeBaseLots: 10n, sizePercent: null, less: null },
      },
    ])
    expect(outcome).toMatchObject({
      result: {
        summary: 'Set take profit on 0.1 of the 0.25 SOL long',
        details: { size: '0.1 SOL' },
      },
    })
  })

  test('an isolated position is set in its own subaccount', async () => {
    for (const input of [{}, { subaccount: 3 }]) {
      const { outcome, request } = await set(
        { takeProfit: TP, percent: 100, ...input },
        { cross: '0', isolated: '40' },
      )
      expect(request).toMatchObject({
        isIsolated: true,
        traderSubaccountIndex: 3,
      })
      expect(outcome).toMatchObject({
        result: {
          details: { subaccount: '3', marginMode: 'isolated' },
          trade: { marginMode: 'isolated' },
        },
      })
    }
  })

  test('a market open in two subaccounts needs subaccount', async () => {
    expect(
      (
        await set(
          { takeProfit: TP, percent: 100 },
          { cross: '25', isolated: '40' },
        )
      ).outcome,
    ).toMatchObject(
      refusal(
        'invalid_input',
        'SOL is open in subaccounts 0 and 3; pass subaccount from phoenix_get_account',
      ),
    )
  })

  test('every review says how triggers behave', async () => {
    const { outcome } = await set({ stopLoss: SL, percent: 100 })
    if (!outcome.ok || outcome.result.status !== 'ready')
      throw new Error('expected a ready result')
    expect(outcome.result.warnings).toEqual(
      expect.arrayContaining([
        'Triggers use mark price.',
        'A stop may not fill past its worst price.',
        'Phoenix cancels TP/SL if the position flips.',
      ]),
    )
  })

  test('first TP/SL on an account says it pays rent, and only then', async () => {
    const warnings = async (world: World) => {
      const { outcome } = await set({ takeProfit: TP, percent: 100 }, world)
      return outcome.ok && outcome.result.status === 'ready'
        ? outcome.result.warnings.join(' ')
        : ''
    }
    const rent = 'a small one-time rent in SOL'
    expect(await warnings({ crossSlots: null })).toContain(rent)
    expect(await warnings({ crossSlots: [] })).not.toContain(rent)
  })

  test('existing TP/SL does not block a new one, and is counted', async () => {
    const { outcome } = await set(
      { takeProfit: TP, percent: 100 },
      {
        crossSlots: [
          longSlot(1),
          longSlot(2),
          longSlot(3, { assetId: 9 }),
          shortSlot(4),
        ],
      },
    )
    expect(outcome).toMatchObject({
      result: {
        status: 'ready',
        details: { activeTpsl: '2' },
        warnings: expect.arrayContaining([
          'This position already has 2 active TP/SL; this one adds to them and replaces none.',
        ]),
      },
    })
  })

  test('triggers on the wrong side of mark are refused', async () => {
    const atMark = { triggerPrice: '115.15', worstPrice: '115' }
    const cases = [
      ['long', { takeProfit: { ...TP, triggerPrice: '110' } }, 'take profit'],
      ['long', { takeProfit: atMark }, 'take profit'],
      ['long', { stopLoss: { ...SL, triggerPrice: '116' } }, 'stop loss'],
      ['long', { stopLoss: atMark }, 'stop loss'],
      ['short', { takeProfit: SHORT_SL }, 'take profit'],
      ['short', { stopLoss: SHORT_TP }, 'stop loss'],
    ] as const
    for (const [direction, input, name] of cases) {
      const orders = fakeOrders()
      const { outcome } = await set(
        { ...input, percent: 100 },
        { cross: direction === 'long' ? '25' : '-25' },
        orders,
      )
      const above =
        (name === 'take profit') === (direction === 'long') ? 'above' : 'below'
      expect(outcome).toMatchObject(
        refusal(
          'invalid_input',
          `A ${direction}'s ${name} must trigger ${above} the mark price`,
        ),
      )
      expect(orders.place).toEqual([])
    }
  })

  test("a stop's worst price on the wrong side of its trigger is refused", async () => {
    expect(
      (await set({ stopLoss: { ...SL, worstPrice: '111' }, percent: 100 }))
        .outcome,
    ).toMatchObject(
      refusal(
        'invalid_input',
        'stopLoss worstPrice must be at or below its triggerPrice for a long',
      ),
    )
    expect(
      (
        await set(
          { stopLoss: { ...SHORT_SL, worstPrice: '119' }, percent: 100 },
          { cross: '-25' },
        )
      ).outcome,
    ).toMatchObject(
      refusal(
        'invalid_input',
        'stopLoss worstPrice must be at or above its triggerPrice for a short',
      ),
    )
    // Exactly at the trigger is allowed, and a take profit has no such rule.
    expect(
      (await set({ stopLoss: { ...SL, worstPrice: '110' }, percent: 100 }))
        .outcome,
    ).toMatchObject({ result: { status: 'ready' } })
    expect(
      (await set({ takeProfit: { ...TP, worstPrice: '121' }, percent: 100 }))
        .outcome,
    ).toMatchObject({ result: { status: 'ready' } })
  })

  test('a size over the position is refused', async () => {
    const orders = fakeOrders()
    const { outcome } = await set({ takeProfit: TP, size: '0.26' }, {}, orders)
    expect(outcome).toMatchObject(
      refusal('invalid_input', 'size 0.26 is more than the 0.25 position'),
    )
    expect(orders.place).toEqual([])
  })

  test('a size off the lot grid is refused', async () => {
    expect(
      (await set({ takeProfit: TP, size: '0.123' })).outcome,
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: "size must be a multiple of this market's lot size, 0.01",
      },
    })
  })

  test('a percent below one lot is refused', async () => {
    expect((await set({ takeProfit: TP, percent: 3 })).outcome).toMatchObject(
      refusal(
        'invalid_input',
        '3% of this position is less than one lot; use a larger percent or a size',
      ),
    )
  })

  test('no position is not found', async () => {
    const orders = fakeOrders()
    const { outcome } = await set(
      { takeProfit: TP, percent: 100 },
      { cross: '0' },
      orders,
    )
    expect(outcome).toMatchObject(
      refusal('not_found', 'This account has no open SOL position'),
    )
    expect(orders.place).toEqual([])
  })

  test('the inputs need a leg and exactly one size', async () => {
    for (const [input, message] of [
      [{ percent: 100 }, 'Give takeProfit, stopLoss or both'],
      [{ takeProfit: TP }, 'Give exactly one of percent or size'],
      [
        { takeProfit: TP, percent: 100, size: '0.1' },
        'Give exactly one of percent or size',
      ],
    ] as const)
      expect((await set(input)).outcome).toMatchObject(
        refusal('invalid_input', message),
      )
    for (const percent of [0, 101, 1.5])
      expect((await set({ takeProfit: TP, percent })).outcome).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
    expect(
      (
        await set({
          takeProfit: { triggerPrice: '120' },
          percent: 100,
        })
      ).outcome,
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  })

  test('no mark price is not guessed', async () => {
    expect(
      (await set({ takeProfit: TP, percent: 100 }, { stats: { markets: [] } }))
        .outcome,
    ).toMatchObject(
      refusal('market_unavailable', 'Phoenix sent no mark price for SOL'),
    )
  })

  test('a server answer that differs from the request is refused', async () => {
    const tampers = [
      (request: object) => ({ ...request, sizePercent: 99 }),
      (request: object) => ({ ...request, traderSubaccountIndex: 3 }),
      (request: object) => ({
        ...request,
        greaterTrigger: {
          side: 'sell',
          orderKind: 'limit',
          triggerPriceInTicks: 12000,
          executionPriceInTicks: 1,
        },
      }),
      (request: object) => ({ ...request, lessTrigger: null }),
    ] as const
    for (const tamperPlace of tampers) {
      const { outcome } = await set(
        { takeProfit: TP, stopLoss: SL, percent: 100 },
        {},
        fakeOrders({
          tamperPlace: tamperPlace as never,
        }),
      )
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'check_failed' },
      })
    }
  })
})

describe('phoenix_cancel_tpsl', () => {
  const cancels = (outcome: TradeOutcome) =>
    steps(outcome).map((step) =>
      step?.kind === 'cancel_conditional'
        ? [step.index, step.disableFirst, step.disableSecond]
        : null,
    )

  test("a long's take profit is its greater leg", async () => {
    const { outcome, requests } = await cancel(
      { leg: 'takeProfit', slot: 1 },
      { crossSlots: [longSlot(1)] },
    )
    expect(requests).toEqual([
      {
        authority: WALLET,
        traderPdaIndex: 0,
        traderSubaccountIndex: 0,
        isIsolated: false,
        symbol: 'SOL',
        conditionalOrderIndex: 1,
        executionDirection: 'greater_than',
      },
    ])
    expect(cancels(outcome)).toEqual([[1, true, false]])
    expect(outcome).toMatchObject({
      result: {
        summary: 'Cancel 1 TP/SL leg on the SOL long',
        details: {
          'slot 1 take profit':
            'trigger $120, worst $119.5, size 50% of the position',
        },
        trade: {
          action: 'cancel_tpsl',
          symbol: 'SOL',
          closing: 'long',
          cancelled: 1,
        },
        warnings: ['This position keeps 1 active TP/SL leg.'],
      },
    })
  })

  test("a long's stop loss is its less leg", async () => {
    const { outcome, requests } = await cancel(
      { leg: 'stopLoss', slot: 1 },
      { crossSlots: [longSlot(1)] },
    )
    expect(requests[0]?.executionDirection).toBe('less_than')
    expect(cancels(outcome)).toEqual([[1, false, true]])
  })

  test("a short's legs are reversed", async () => {
    const world = { cross: '-30', crossSlots: [shortSlot(2)] }
    const profit = await cancel({ leg: 'takeProfit', slot: 2 }, world)
    expect(profit.requests[0]?.executionDirection).toBe('less_than')
    expect(cancels(profit.outcome)).toEqual([[2, false, true]])
    expect(profit.outcome).toMatchObject({
      result: {
        details: {
          'slot 2 take profit': 'trigger $110, worst $110.5, size 0.1 SOL',
        },
      },
    })
    const stop = await cancel({ leg: 'stopLoss', slot: 2 }, world)
    expect(stop.requests[0]?.executionDirection).toBe('greater_than')
    expect(cancels(stop.outcome)).toEqual([[2, true, false]])
  })

  test('both legs of a slot are one instruction each', async () => {
    const { outcome } = await cancel(
      { leg: 'both', slot: 1 },
      { crossSlots: [longSlot(1)] },
    )
    expect(cancels(outcome)).toEqual([
      [1, true, false],
      [1, false, true],
    ])
    expect(outcome).toMatchObject({
      result: {
        summary: 'Cancel 2 TP/SL legs on the SOL long',
        warnings: ['This position will have no TP/SL left.'],
      },
    })
  })

  test('without a slot every active leg of the position goes', async () => {
    const { outcome } = await cancel(
      { leg: 'takeProfit' },
      {
        crossSlots: [
          longSlot(1),
          longSlot(2, { greater: undefined }),
          longSlot(3),
          longSlot(4, { assetId: 9 }),
        ],
      },
    )
    // Slot 2's take profit is dead and slot 4 is another market's.
    expect(cancels(outcome)).toEqual([
      [1, true, false],
      [3, true, false],
    ])
  })

  test('an inactive leg is skipped under both', async () => {
    const { outcome } = await cancel(
      { leg: 'both' },
      { crossSlots: [longSlot(1, { less: undefined })] },
    )
    expect(cancels(outcome)).toEqual([[1, true, false]])
  })

  test('an isolated position cancels in its own subaccount', async () => {
    const { outcome, requests } = await cancel(
      { leg: 'takeProfit', slot: 1, subaccount: 3 },
      {
        cross: '25',
        isolated: '40',
        crossSlots: [longSlot(2)],
        isolatedSlots: [longSlot(1)],
      },
    )
    expect(requests).toMatchObject([
      {
        isIsolated: true,
        traderSubaccountIndex: 3,
        conditionalOrderIndex: 1,
      },
    ])
    expect(cancels(outcome)).toEqual([[1, true, false]])
  })

  test('a slot that is not active lists the ones that are', async () => {
    const orders = fakeOrders()
    const { outcome } = await cancel(
      { leg: 'takeProfit', slot: 5 },
      {
        crossSlots: [longSlot(1), longSlot(3, { greater: undefined })],
      },
      orders,
    )
    expect(outcome).toMatchObject(
      refusal(
        'not_found',
        'No active take profit in slot 5 on this SOL position; active slots: 1 (take profit, stop loss), 3 (stop loss)',
      ),
    )
    expect(orders.cancel).toEqual([])
  })

  test('a slot without that leg is refused rather than cancelling the other', async () => {
    const orders = fakeOrders()
    const { outcome } = await cancel(
      { leg: 'takeProfit', slot: 3 },
      { crossSlots: [longSlot(3, { greater: undefined })] },
      orders,
    )
    expect(outcome).toMatchObject(
      refusal(
        'not_found',
        'No active take profit in slot 3 on this SOL position; active slots: 3 (stop loss)',
      ),
    )
    expect(orders.cancel).toEqual([])
  })

  test("another market's slot is not this position's", async () => {
    expect(
      (
        await cancel(
          { leg: 'both', slot: 2 },
          { crossSlots: [longSlot(1), longSlot(2, { assetId: 9 })] },
        )
      ).outcome,
    ).toMatchObject(
      refusal(
        'not_found',
        'No active TP/SL in slot 2 on this SOL position; active slots: 1 (take profit, stop loss)',
      ),
    )
  })

  test('no TP/SL at all is not found, with or without the account', async () => {
    for (const crossSlots of [null, [], [longSlot(1, { assetId: 9 })]])
      expect(
        (await cancel({ leg: 'both' }, { crossSlots })).outcome,
      ).toMatchObject(
        refusal('not_found', 'This SOL position has no active TP/SL'),
      )
  })

  test('no position is not found', async () => {
    expect(
      (await cancel({ leg: 'both' }, { cross: '0' })).outcome,
    ).toMatchObject(
      refusal('not_found', 'This account has no open SOL position'),
    )
  })

  test('slot and leg are checked', async () => {
    for (const input of [
      { leg: 'all' },
      { leg: 'both', slot: 0 },
      { leg: 'both', slot: 192 },
      { leg: 'both', slot: 1.5 },
      {},
    ])
      expect((await cancel(input)).outcome).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      })
  })

  test('a server answer naming another leg or slot is refused', async () => {
    const world = { crossSlots: [longSlot(1), longSlot(2)] }
    const tampers = [
      {
        executionDirection: 'less_than',
      },
      { conditionalOrderIndex: 2 },
      { traderSubaccountIndex: 3 },
    ]
    for (const change of tampers) {
      const { outcome } = await cancel(
        { leg: 'takeProfit', slot: 1 },
        world,
        fakeOrders({
          tamperCancel: (request) => ({ ...request, ...change }) as never,
        }),
      )
      expect(outcome).toMatchObject({
        ok: false,
        error: { code: 'check_failed' },
      })
    }
  })

  test('cancels too many for one transaction are refused, listing slots', async () => {
    // 28 slots pass the instruction limit and overflow the bytes; 120 do both.
    for (const length of [28, 120]) {
      const crossSlots = Array.from({ length }, (_, index) =>
        longSlot(index + 1),
      )
      const { outcome } = await cancel({ leg: 'both' }, { crossSlots })
      if (outcome.ok) throw new Error('expected a refusal')
      expect(outcome.error.code).toBe('invalid_input')
      expect(outcome.error.message).toContain(
        'These cancels do not fit one transaction; give slot to cancel fewer. Active slots: 1 (take profit, stop loss), 2 (take profit, stop loss)',
      )
    }
  })

  test('a full account of 7 slots still cancels in one transaction', async () => {
    const crossSlots = Array.from({ length: 7 }, (_, index) =>
      longSlot(index + 1),
    )
    const { outcome } = await cancel({ leg: 'both' }, { crossSlots })
    expect(steps(outcome)).toHaveLength(14)
  })

  test('a TP/SL account of another trader is refused', async () => {
    const context_ = await context({})
    const stranger = conditionalAccountData(ISOLATED, [longSlot(1)])
    const collection = await conditionalOrdersAddress(CROSS)
    const rpc = fakeRpc({
      getAccountInfo: (account) => {
        if (account === collection)
          return accountInfo(PHOENIX_PROGRAM, stranger)
        return accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
      },
    }).rpc
    expect(
      await runTradeTool(
        cancelTpsl,
        { wallet: WALLET, symbol: 'SOL', leg: 'both' },
        { ...context_, rpc },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'check_failed',
        message:
          'The Phoenix TP/SL account belongs to another trader; nothing was built',
      },
    })
  })

  test('a TP/SL account Phoenix does not own is refused', async () => {
    const context_ = await context({})
    const collection = await conditionalOrdersAddress(CROSS)
    const rpc = fakeRpc({
      getAccountInfo: (account) =>
        account === collection
          ? accountInfo(WALLET, new Uint8Array(992))
          : accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA),
    }).rpc
    expect(
      await runTradeTool(
        cancelTpsl,
        { wallet: WALLET, symbol: 'SOL', leg: 'both' },
        { ...context_, rpc },
      ),
    ).toMatchObject({ ok: false, error: { code: 'upstream_error' } })
  })
})

describe('TP/SL on a market order', () => {
  const order = async (
    input: Record<string, unknown>,
    world: World = { cross: '0' },
    orders = fakeOrders(),
  ) => {
    const base = await context(world, orders)
    const { rpc } = fakeRpc({
      getSlot: () => 1_000n,
      getAccountInfo: (account) =>
        String(account) === CROSS
          ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
          : { value: null },
      getLatestBlockhash: () => ({
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
      }),
      simulateTransaction: () => ({
        value: { err: null, unitsConsumed: 40_000n, logs: [] },
      }),
    })
    return {
      outcome: await runTradeTool(
        marketOrder,
        {
          wallet: WALLET,
          symbol: 'SOL',
          side: 'buy',
          size: '0.1',
          maxSlippageBps: 100,
          ...input,
        },
        {
          ...base,
          rpc,
          fetch: fakePhoenix({
            '/v1/view/exchange/market/SOL': SOL_MARKET,
            '/v1/view/exchange/keys': KEYS,
            '/v1/view/orderbook/SOL': SOL_BOOK,
            '/v1/markets/stats/latest': STATS,
            [`/v1/trader/state/${WALLET}`]: state(world),
          }).fetch,
        },
      ),
      request: orders.place[0],
    }
  }

  test('a cross order and its TP/SL land in one transaction', async () => {
    const { outcome, request } = await order({ takeProfit: TP, stopLoss: SL })
    expect(request).toMatchObject({ authority: WALLET, sizePercent: 100 })
    const result = ready(outcome)
    expect(result.trade).toMatchObject({
      action: 'order',
      takeProfitPrice: '120',
      stopLossPrice: '110',
    })
    expect(result.warnings).toContain(
      'A stop may not fill past its worst price.',
    )
    expect(result.warnings.join(' ')).toContain(
      'when one fires, Phoenix cancels the other',
    )
    expect(result.expiresAfterSlot).toBeDefined()
    expect(
      messageOf(result.transaction)
        .instructions.filter((step) => step.programAddress === PHOENIX_PROGRAM)
        .map(
          (step) =>
            decodeBundleStep(Uint8Array.from(step.data ?? []))?.kind ?? null,
        ),
    ).toEqual(['order', 'place_conditional'])
  })

  test('without TP/SL nothing else is asked for', async () => {
    const { outcome, request } = await order({})
    ready(outcome)
    expect(request).toBeUndefined()
  })

  test('a wrong answer from Phoenix is refused', async () => {
    const orders = fakeOrders({
      tamperPlace: (request) => ({ ...request, sizePercent: 50 }),
    })
    const { outcome } = await order({ stopLoss: SL }, { cross: '0' }, orders)
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'check_failed' },
    })
  })

  test('a trigger past mark, a reduce-only order and an opposite position are refused', async () => {
    expect(
      (await order({ stopLoss: { triggerPrice: '120', worstPrice: '119' } }))
        .outcome,
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(
      (await order({ reduceOnly: true, stopLoss: SL })).outcome,
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'A reduce-only order cannot set TP/SL',
      },
    })
    expect(
      (await order({ stopLoss: SL }, { cross: '-25' })).outcome,
    ).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: expect.stringContaining('phoenix_set_tpsl'),
      },
    })
  })
})

test('a partial TP/SL says it closes only its share', async () => {
  const { outcome } = await set({ takeProfit: TP, percent: 50 })
  expect(ready(outcome).warnings).toContainEqual(
    expect.stringContaining('closes only this share'),
  )
})

test('a TP and SL set together say they are one pair, and one leg does not', async () => {
  const pair = 'when one fires, Phoenix cancels the other'
  const both = await set({ takeProfit: TP, stopLoss: SL, percent: 100 })
  expect(ready(both.outcome).warnings.join(' ')).toContain(pair)
  const one = await set({ takeProfit: TP, percent: 100 })
  expect(ready(one.outcome).warnings.join(' ')).not.toContain(pair)
})
