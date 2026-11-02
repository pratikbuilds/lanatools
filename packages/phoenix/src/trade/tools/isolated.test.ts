import { describe, expect, test } from 'bun:test'
import { address } from '@solana/kit'
import type { Instruction } from '@solana/kit'
import {
  BLOCKHASH,
  SOL_BOOK,
  SOL_MARKET,
  KEYS,
  TRADER_ACCOUNT_DATA,
  WALLET,
  accountInfo,
  fakePhoenix,
  fakeRpc,
} from '../fixtures'
import bundles from '../fixtures/phoenix-bundles.json'
import {
  PHOENIX_PROGRAM,
  decodeBundleStep,
  toInstruction,
  traderAccountAddress,
} from '../rise'
import type { PhoenixOrders, RiseInstruction } from '../rise'
import { ISOLATED_RISK, runTradeTool } from '../tool'
import type { TradeOutcome } from '../tool'
import { limitOrder } from './limit-order'
import { marketOrder } from './market-order'

// Orders answered by the real responses saved in phoenix-bundles.json, whose
// wallets are public. `A` has no isolated subaccount yet.
const A = address(bundles.wallets.A)
const D = address(bundles.wallets.D)
const GOLD = bundles.markets.GOLD
const STONK = bundles.markets.STONK
const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }
const FIRST_USE =
  'This order creates a new Phoenix subaccount, which costs a small one-time rent in SOL. Treat it as spent.'

/** Best bid 3870, best ask 3908.5. */
const GOLD_BOOK = {
  symbol: 'GOLD',
  mid: 3889.25,
  bids: [[3870, 10]],
  asks: [[3908.5, 10]],
}
const STONK_BOOK = {
  symbol: 'STONK',
  mid: 0.1275,
  bids: [[0.1274, 10]],
  asks: [[0.1276, 10]],
}

type Row = {
  subaccountIndex: number
  collateral?: string
  spotCollaterals?: Array<{ symbol: string; balance: string }>
  positions?: Array<{ symbol: string; basePositionLots: string }>
}

/** Cross holds 5 USDC and 0.1 SOL, and no position. */
const CROSS: Row = {
  subaccountIndex: 0,
  collateral: '5000000',
  spotCollaterals: [{ symbol: 'SOL', balance: '100000000' }],
  positions: [],
}
const state = (...rows: Row[]) => ({
  snapshot: {
    subaccounts: rows.map((row) => ({ collateral: '0', ...row })),
  },
})
const stateFor = (position: Row['positions']) =>
  state({ ...CROSS, positions: position ?? [] })

type Call = { route: string; request: Record<string, unknown> }

function fakeOrders(bundle: readonly RiseInstruction[] | Instruction[]) {
  const calls: Call[] = []
  const answer = (route: string) => async (request: object) => {
    calls.push({ route, request: { ...request } })
    return (bundle as RiseInstruction[]).map(toInstruction)
  }
  const orders = {
    placeIsolatedMarketOrder: answer('market'),
    placeIsolatedLimitOrder: answer('limit'),
  } as unknown as PhoenixOrders
  return { orders, calls }
}

async function rpcFor(wallet: typeof A) {
  const trader = await traderAccountAddress(wallet)
  return fakeRpc({
    getAccountInfo: (account) =>
      account === trader
        ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
        : { value: null },
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 180_000n, logs: [] },
    }),
  })
}

async function setup(
  bundle: readonly RiseInstruction[] | Instruction[],
  {
    trader = stateFor([]),
    wallet = A,
    answers = {},
  }: {
    trader?: unknown
    wallet?: typeof A
    answers?: Record<string, unknown>
  } = {},
) {
  const { orders, calls } = fakeOrders(bundle)
  const { rpc } = await rpcFor(wallet)
  return {
    calls,
    opts: {
      rpc,
      fees: FEES,
      orders,
      fetch: fakePhoenix({
        '/v1/view/exchange/market/GOLD': GOLD,
        '/v1/view/exchange/market/STONK': STONK,
        '/v1/view/orderbook/GOLD': GOLD_BOOK,
        '/v1/view/orderbook/STONK': STONK_BOOK,
        '/v1/view/exchange/keys': bundles.keys,
        [`/v1/trader/state/${wallet}`]: trader,
        ...answers,
      }).fetch,
    },
  }
}

const isolated = {
  wallet: A,
  symbol: 'GOLD',
  marginMode: 'isolated',
}
const short = {
  ...isolated,
  side: 'sell',
  size: '0.01',
  limitPrice: '3850.2',
  collateralUsdc: '2',
}
const resting = {
  ...isolated,
  side: 'buy',
  size: '0.01',
  price: '3111.3',
  collateralUsdc: '2',
}

function ready(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  return outcome.result
}

const refused = (code: string, message: string) => ({
  ok: false,
  error: { code, message: expect.stringContaining(message) as string },
})

const without = (bundle: readonly RiseInstruction[], kinds: string[]) =>
  bundle.filter(
    ({ data }) =>
      !kinds.includes(
        decodeBundleStep(Uint8Array.from(data ?? []))?.kind ?? 'unknown',
      ),
  )

describe('an isolated market order', () => {
  test('a short asks for the worst price and exact collateral', async () => {
    const { opts, calls } = await setup(bundles.sellShort)
    const result = ready(await runTradeTool(marketOrder, short, opts))
    expect(calls).toEqual([
      {
        route: 'market',
        request: {
          authority: A,
          symbol: 'GOLD',
          side: 'sell',
          numBaseLots: 10,
          maxPriceInTicks: 38502,
          minBaseLotsToFill: 1,
          transferAmount: 2_000_000,
        },
      },
    ])
    expect(result).toMatchObject({
      summary:
        'Isolated market sell (short): 0.01 GOLD perp now, receiving at least $3850.2 each; any part that cannot fill at that price is cancelled. Funded with 2 USDC from your cross account.',
      details: {
        marginMode: 'isolated',
        subaccount: '1',
        collateralUsdc: '2',
        limitPrice: '3850.2',
        bestPrice: '3870',
      },
      trade: {
        action: 'order',
        marginMode: 'isolated',
        subaccount: 1,
        collateralUsdc: '2',
        worstPrice: '3850.2',
      },
      warnings: [ISOLATED_RISK, FIRST_USE],
    })
    expect(result.simulation.ok).toBe(true)
  })

  test('has no slot expiry, its warning, or a position to report', async () => {
    // The fake RPC would refuse getSlot.
    const { opts } = await setup(bundles.sellShort)
    const result = ready(await runTradeTool(marketOrder, short, opts))
    expect(result.expiresAfterSlot).toBeUndefined()
    expect(result.details).not.toHaveProperty('expiresAfterSlot')
    expect(result.position).toBeUndefined()
    expect(result.warnings.join(' ')).not.toContain('expires')
  })

  test('SOL alone funds it, and slippage sets the same worst price', async () => {
    const { opts, calls } = await setup(bundles.openSol, {
      trader: stateFor([]),
    })
    // Best ask 3908.5 is 39085 ticks; × 1.005 rounds down to 39280.
    const result = ready(
      await runTradeTool(
        marketOrder,
        {
          ...isolated,
          side: 'buy',
          size: '0.001',
          maxSlippageBps: 50,
          collateralSol: '0.05',
        },
        opts,
      ),
    )
    expect(calls[0]?.request).toEqual({
      authority: A,
      symbol: 'GOLD',
      side: 'buy',
      numBaseLots: 1,
      maxPriceInTicks: 39280,
      minBaseLotsToFill: 1,
      transferSpotCollateralAmounts: { SOL: 50_000_000 },
    })
    expect(result.trade).toMatchObject({
      marginMode: 'isolated',
      collateralSol: '0.05',
    })
    expect(result.trade).not.toHaveProperty('collateralUsdc')
  })

  test('a limit out of reach still warns', async () => {
    const { opts } = await setup(bundles.sellShort, {
      answers: {
        '/v1/view/orderbook/GOLD': { ...GOLD_BOOK, bids: [[3800, 10]] },
      },
    })
    expect(
      ready(await runTradeTool(marketOrder, short, opts)).warnings,
    ).toEqual([
      ISOLATED_RISK,
      FIRST_USE,
      'The limit is above the best bid (3800), so this order will not fill now.',
    ])
  })

  test('works on a market that also trades in cross', async () => {
    const { opts } = await setup(bundles.sellShort, {
      answers: {
        '/v1/view/exchange/market/GOLD': { ...GOLD, isolatedOnly: false },
      },
    })
    expect(ready(await runTradeTool(marketOrder, short, opts)).status).toBe(
      'ready',
    )
  })

  test('adds to an open isolated position without new collateral or rent', async () => {
    const { opts, calls } = await setup(
      without(bundles.sellShort, ['register', 'transfer_usdc']),
      {
        trader: state(CROSS, {
          subaccountIndex: 1,
          positions: [{ symbol: 'GOLD', basePositionLots: '-10' }],
        }),
      },
    )
    const { collateralUsdc: _none, ...noCollateral } = short
    const result = ready(await runTradeTool(marketOrder, noCollateral, opts))
    expect(calls[0]?.request).not.toHaveProperty('transferAmount')
    expect(calls[0]?.request).not.toHaveProperty(
      'transferSpotCollateralAmounts',
    )
    expect(result.warnings).toEqual([ISOLATED_RISK])
    expect(result.summary).toEndWith('Moves no new collateral.')
    expect(result.trade).toMatchObject({ subaccount: 1 })
  })

  test('reduce-only keeps its flag, and moves no collateral', async () => {
    const trader = state(
      { ...CROSS },
      {
        subaccountIndex: bundles.closeMeta.subaccount,
        positions: [{ symbol: 'STONK', basePositionLots: '-7' }],
      },
    )
    const { opts, calls } = await setup(bundles.close, { wallet: D, trader })
    const order = {
      wallet: D,
      symbol: 'STONK',
      marginMode: 'isolated',
      side: 'buy',
      size: '7',
      limitPrice: '0.12972',
      reduceOnly: true,
    }
    ready(await runTradeTool(marketOrder, order, opts))
    expect(calls[0]?.request).toMatchObject({
      isReduceOnly: true,
      maxPriceInTicks: 12972,
    })
    expect(
      await runTradeTool(marketOrder, { ...order, collateralUsdc: '1' }, opts),
    ).toMatchObject(refused('invalid_input', 'moves no collateral'))
  })
})

describe('an isolated limit order', () => {
  test('rests, funded by exact collateral', async () => {
    const { opts, calls } = await setup(bundles.limit)
    const result = ready(await runTradeTool(limitOrder, resting, opts))
    expect(calls).toEqual([
      {
        route: 'limit',
        request: {
          authority: A,
          symbol: 'GOLD',
          side: 'buy',
          numBaseLots: 10,
          priceInTicks: 31113,
          isPostOnly: false,
          isReduceOnly: false,
          transferAmount: 2_000_000,
        },
      },
    ])
    expect(result).toMatchObject({
      summary:
        'Isolated limit buy (long): 0.01 GOLD perp at $3111.3; it rests on the book until filled or cancelled. Funded with 2 USDC from your cross account.',
      details: { marginMode: 'isolated', subaccount: '1', bestAsk: '3908.5' },
      trade: {
        orderType: 'limit',
        marginMode: 'isolated',
        subaccount: 1,
        collateralUsdc: '2',
      },
      warnings: [ISOLATED_RISK, FIRST_USE],
    })
  })

  test('post-only', async () => {
    const { opts, calls } = await setup(bundles.limitPost)
    const result = ready(
      await runTradeTool(limitOrder, { ...resting, postOnly: true }, opts),
    )
    expect(calls[0]?.request).toMatchObject({ isPostOnly: true })
    expect(result.summary).toStartWith('Isolated post-only limit buy (long)')
    expect(result.trade).toMatchObject({ postOnly: true })
  })

  test('still warns when it crosses the book', async () => {
    const { opts } = await setup(bundles.limit, {
      answers: {
        '/v1/view/orderbook/GOLD': { ...GOLD_BOOK, asks: [[3000, 10]] },
      },
    })
    expect(
      ready(await runTradeTool(limitOrder, resting, opts)).warnings,
    ).toContain(
      'The price crosses the book (3000), so this order will fill at once as a taker instead of resting.',
    )
  })
})

describe("Phoenix's answer is refused unless it is exactly the request", () => {
  test.each([
    ['a different price', { limitPrice: '3851' }, 'priceInTicks'],
    ['a different size', { size: '0.02' }, 'numBaseLots'],
    ['the other side', { side: 'buy', limitPrice: '3850.2' }, 'side'],
    ['different collateral', { collateralUsdc: '3' }, 'USDC collateral'],
  ])('%s', async (_name, change, reason) => {
    const { opts, calls } = await setup(bundles.sellShort)
    expect(
      await runTradeTool(marketOrder, { ...short, ...change }, opts),
    ).toMatchObject(refused('check_failed', reason))
    expect(calls).toHaveLength(1)
  })

  test('a TP/SL nobody asked for', async () => {
    const { opts } = await setup(bundles.openWithTpsl)
    expect(
      await runTradeTool(
        marketOrder,
        { ...short, side: 'buy', limitPrice: '3928' },
        opts,
      ),
    ).toMatchObject(refused('check_failed', 'TP/SL nobody asked for'))
  })

  test('a bundle for another wallet', async () => {
    const { opts } = await setup(bundles.sellShort, {
      wallet: WALLET,
      answers: { [`/v1/trader/state/${WALLET}`]: stateFor([]) },
    })
    expect(
      await runTradeTool(marketOrder, { ...short, wallet: WALLET }, opts),
    ).toMatchObject(refused('check_failed', 'safety check'))
  })

  test('a subaccount other than the one holding the position', async () => {
    const { opts } = await setup(bundles.sellShort, {
      trader: state(CROSS, {
        subaccountIndex: 2,
        positions: [{ symbol: 'GOLD', basePositionLots: '10' }],
      }),
    })
    expect(await runTradeTool(marketOrder, short, opts)).toMatchObject(
      refused('check_failed', 'wrong subaccount'),
    )
  })

  test('a limit order that came back post-only', async () => {
    const { opts } = await setup(bundles.limitPost)
    expect(await runTradeTool(limitOrder, resting, opts)).toMatchObject(
      refused('check_failed', 'kind'),
    )
  })
})

describe('refused before asking Phoenix', () => {
  const refusedUnasked = async (
    tool: typeof marketOrder | typeof limitOrder,
    input: object,
    trader: unknown,
    code: string,
    message: string,
  ) => {
    const { opts, calls } = await setup(bundles.sellShort, { trader })
    const outcome =
      tool === marketOrder
        ? await runTradeTool(marketOrder, input, opts)
        : await runTradeTool(limitOrder, input, opts)
    expect(outcome).toMatchObject(refused(code, message))
    expect(calls).toEqual([])
  }

  test('a market with an open cross position (D2)', async () => {
    const cross = stateFor([{ symbol: 'GOLD', basePositionLots: '3' }])
    await refusedUnasked(
      marketOrder,
      short,
      cross,
      'invalid_input',
      'open cross position',
    )
    await refusedUnasked(
      limitOrder,
      resting,
      cross,
      'invalid_input',
      'open cross position',
    )
  })

  test('another market in cross, or a flat row, does not count', async () => {
    const { opts } = await setup(bundles.sellShort, {
      trader: stateFor([
        { symbol: 'SOL', basePositionLots: '3' },
        { symbol: 'GOLD', basePositionLots: '0' },
      ]),
    })
    expect(ready(await runTradeTool(marketOrder, short, opts)).status).toBe(
      'ready',
    )
  })

  test('a new position without collateral', async () => {
    const { collateralUsdc: _market, ...market } = short
    const { collateralUsdc: _limit, ...limit } = resting
    const message = 'needs collateralUsdc or collateralSol'
    await refusedUnasked(
      marketOrder,
      market,
      stateFor([]),
      'invalid_input',
      message,
    )
    await refusedUnasked(
      limitOrder,
      limit,
      stateFor([]),
      'invalid_input',
      message,
    )
  })

  test('collateral cross cannot cover', async () => {
    await refusedUnasked(
      marketOrder,
      { ...short, collateralUsdc: '5.000001' },
      stateFor([]),
      'insufficient_funds',
      'phoenix_deposit',
    )
    await refusedUnasked(
      limitOrder,
      { ...resting, collateralUsdc: undefined, collateralSol: '0.100000001' },
      stateFor([]),
      'insufficient_funds',
      'phoenix_deposit',
    )
  })

  test('a wallet with no cross row holds nothing', async () => {
    await refusedUnasked(
      marketOrder,
      short,
      state({ subaccountIndex: 4 }),
      'insufficient_funds',
      'holds 0 USDC',
    )
  })

  test('the two open isolated positions it cannot choose between', async () => {
    const row = (subaccountIndex: number) => ({
      subaccountIndex,
      positions: [{ symbol: 'GOLD', basePositionLots: '1' }],
    })
    await refusedUnasked(
      marketOrder,
      short,
      state(CROSS, row(1), row(2)),
      'invalid_input',
      'subaccounts 1 and 2',
    )
  })

  test('reduce-only with nothing to reduce', async () => {
    await refusedUnasked(
      marketOrder,
      { ...short, reduceOnly: true, collateralUsdc: undefined },
      stateFor([]),
      'invalid_input',
      'open isolated position',
    )
  })

  test('collateral that is zero or too precise', async () => {
    await refusedUnasked(
      marketOrder,
      { ...short, collateralUsdc: '0' },
      stateFor([]),
      'invalid_input',
      'collateralUsdc must be more than 0',
    )
    await refusedUnasked(
      marketOrder,
      { ...short, collateralSol: '0.0000000001' },
      stateFor([]),
      'invalid_input',
      'collateralSol must have at most 9 decimals',
    )
  })

  test('numbers a JS number cannot hold exactly', async () => {
    const rich = state({
      ...CROSS,
      collateral: '90071992547409930000',
      spotCollaterals: [{ symbol: 'SOL', balance: '90071992547409930000' }],
    })
    const message = "too large for Phoenix's order API"
    await refusedUnasked(
      marketOrder,
      { ...short, size: '9007199254740.993' },
      rich,
      'invalid_input',
      message,
    )
    await refusedUnasked(
      limitOrder,
      { ...resting, price: '900719925474099.3' },
      rich,
      'invalid_input',
      message,
    )
    await refusedUnasked(
      marketOrder,
      { ...short, collateralUsdc: '9007199254.740993' },
      rich,
      'invalid_input',
      message,
    )
    await refusedUnasked(
      marketOrder,
      { ...short, collateralSol: '9007199.254740993' },
      rich,
      'invalid_input',
      message,
    )
  })

  test('the largest exact number is still allowed through', async () => {
    const { opts, calls } = await setup(bundles.sellShort)
    // The size is exact, so the request goes out and the check decides.
    expect(
      await runTradeTool(
        marketOrder,
        { ...short, size: '9007199254740.991' },
        opts,
      ),
    ).toMatchObject({ ok: false, error: { code: 'check_failed' } })
    expect(calls[0]?.request.numBaseLots).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('cross orders', () => {
  const cross = {
    wallet: WALLET,
    symbol: 'SOL',
    side: 'buy',
    size: '0.1',
    collateralUsdc: '2',
  }

  test('refuse collateral', async () => {
    const { opts, calls } = await setup(bundles.sellShort)
    for (const [tool, input] of [
      [marketOrder, { ...cross, maxSlippageBps: 50 }],
      [marketOrder, { ...cross, marginMode: 'cross', maxSlippageBps: 50 }],
      [limitOrder, { ...cross, price: '100' }],
    ] as const) {
      const outcome =
        tool === marketOrder
          ? await runTradeTool(marketOrder, input, opts)
          : await runTradeTool(limitOrder, input, opts)
      expect(outcome).toMatchObject(
        refused(
          'invalid_input',
          'collateralUsdc and collateralSol need marginMode isolated',
        ),
      )
    }
    expect(calls).toEqual([])
  })

  test('never ask Phoenix to build, and state no margin terms', async () => {
    const { collateralUsdc: _none, ...order } = cross
    const { orders, calls } = fakeOrders([])
    const trader = await traderAccountAddress(WALLET)
    const { rpc } = fakeRpc({
      getAccountInfo: (account) =>
        account === trader
          ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
          : { value: null },
      getSlot: () => 1_000n,
      getLatestBlockhash: () => ({
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
      }),
      simulateTransaction: () => ({
        value: { err: null, unitsConsumed: 480_000n, logs: [] },
      }),
    })
    const opts = {
      rpc,
      fees: FEES,
      orders,
      // No trader state here: a cross order never reads it.
      fetch: fakePhoenix({
        '/v1/view/exchange/market/SOL': SOL_MARKET,
        '/v1/view/orderbook/SOL': SOL_BOOK,
        '/v1/view/exchange/keys': KEYS,
      }).fetch,
    }
    const market = ready(
      await runTradeTool(marketOrder, { ...order, maxSlippageBps: 50 }, opts),
    )
    expect(market.trade).toEqual({
      kind: 'perp',
      venue: 'phoenix',
      action: 'order',
      symbol: 'SOL',
      side: 'buy',
      orderType: 'market',
      size: '0.1',
      worstPrice: '115.73',
      bestPrice: '115.16',
      notionalUsd: '11.52',
      feeUsd: '0.004031',
      reduceOnly: false,
    })
    expect(Object.keys(market.details)).toEqual([
      'side',
      'size',
      'limitPrice',
      'bestPrice',
      'estimatedNotionalUsd',
      'estimatedTakerFeeUsd',
      'expiresAfterSlot',
      'reduceOnly',
    ])
    expect(market.expiresAfterSlot).toBe('1150')
    expect(market.position).toBeDefined()

    const limit = ready(
      await runTradeTool(limitOrder, { ...order, price: '100' }, opts),
    )
    expect(limit.trade).not.toHaveProperty('marginMode')
    expect(limit.details).not.toHaveProperty('marginMode')
    expect(limit.warnings).toEqual([])
    expect(calls).toEqual([])
  })
})

test('every request stays clear of allowCrossAndIsolatedForAsset', async () => {
  const { opts, calls } = await setup(bundles.limit)
  await runTradeTool(limitOrder, resting, opts)
  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls)).not.toContain('allowCrossAndIsolatedForAsset')
})
