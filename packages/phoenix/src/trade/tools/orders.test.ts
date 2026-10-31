import { expect, test } from 'bun:test'
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
} from '../fixtures'
import { PHOENIX_PROGRAM, decodeOrder, traderAccountAddress } from '../rise'
import { runTradeTool } from '../tool'
import type { TradeOutcome } from '../tool'
import { messageOf } from '../transaction'
import { limitOrder } from './limit-order'
import { marketOrder } from './market-order'

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }
const TRADER = await traderAccountAddress(WALLET)

function rpcFor({ activated = true } = {}) {
  return fakeRpc({
    getAccountInfo: (account) =>
      activated && account === TRADER
        ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
        : { value: null },
    getSlot: () => 1_000n,
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 480_000n, logs: [] },
    }),
  }).rpc
}

function phoenixFor(answers: Record<string, unknown> = {}) {
  return fakePhoenix({
    '/v1/view/exchange/market/SOL': SOL_MARKET,
    '/v1/view/orderbook/SOL': SOL_BOOK,
    '/v1/view/exchange/keys': KEYS,
    ...answers,
  }).fetch
}

const opts = (answers: Record<string, unknown> = {}, rpc = rpcFor()) => ({
  rpc,
  fees: FEES,
  fetch: phoenixFor(answers),
})

/** The order packet inside a ready result's transaction. */
function packetOf(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  const order = messageOf(outcome.result.transaction).instructions.at(-1)
  return decodeOrder(Uint8Array.from(order?.data ?? []))
}

const buy = { wallet: WALLET, symbol: 'SOL', side: 'buy', size: '0.1' }

test('a market buy is limited above the best ask, expires, and may fill partly', async () => {
  const outcome = await runTradeTool(
    marketOrder,
    { ...buy, maxSlippageBps: 50 },
    opts(),
  )
  // Best ask 115.16 × 1.005 = 115.7358, rounded down to 115.73.
  expect(packetOf(outcome)).toEqual({
    kind: 'market',
    side: 'buy',
    priceInTicks: 11573n,
    numBaseLots: 10n,
    minBaseLotsToFill: 1n,
    lastValidSlot: 1_150n,
    reduceOnly: false,
    slide: false,
    cancelExisting: false,
  })
  expect(outcome).toMatchObject({
    ok: true,
    result: {
      expiresAfterSlot: '1150',
      position: { symbol: 'SOL', assetId: 0, baseLotsDecimals: 2 },
      summary:
        'Market buy (long): 0.1 SOL perp now, paying at most $115.73 each; any part that cannot fill at that price is cancelled',
      details: {
        limitPrice: '115.73',
        bestPrice: '115.16',
        estimatedNotionalUsd: '11.52',
        // 11.516 × 0.00035
        estimatedTakerFeeUsd: '0.004031',
        expiresAfterSlot: '1150',
      },
      trade: {
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
      },
      warnings: [
        'This order expires about 30 seconds after it was prepared (slot 1150); after that it is not sent, and must be prepared again.',
      ],
    },
  })
})

test('a market sell with a limit rounds up and warns when out of reach', async () => {
  const outcome = await runTradeTool(
    marketOrder,
    {
      ...buy,
      side: 'sell',
      limitPrice: '116.005',
      reduceOnly: true,
    },
    opts(),
  )
  expect(packetOf(outcome)).toMatchObject({
    side: 'sell',
    priceInTicks: 11601n,
    reduceOnly: true,
  })
  expect(outcome).toMatchObject({
    result: {
      summary:
        'Market sell to reduce a long position: 0.1 SOL perp now, receiving at least $116.01 each; any part that cannot fill at that price is cancelled',
      warnings: [
        'This order expires about 30 seconds after it was prepared (slot 1150); after that it is not sent, and must be prepared again.',
        'The limit is above the best bid (115.15), so this order will not fill now.',
      ],
    },
  })
})

test("a noisy float in Phoenix's book still prices at its own tick", async () => {
  // 115.17999999999999 is the 115.18 level; 0 bps must be exactly it.
  const noisy = { ...SOL_BOOK, asks: [[115.17999999999999, 10]] }
  const outcome = await runTradeTool(
    marketOrder,
    { ...buy, maxSlippageBps: 0 },
    opts({ '/v1/view/orderbook/SOL': noisy }),
  )
  expect(packetOf(outcome)).toMatchObject({ priceInTicks: 11518n })
  expect(outcome).toMatchObject({
    result: { details: { bestPrice: '115.18', limitPrice: '115.18' } },
  })
  // A limit at exactly the best price is in reach: no warning.
  expect(
    await runTradeTool(
      marketOrder,
      { ...buy, limitPrice: '115.18' },
      opts({ '/v1/view/orderbook/SOL': noisy }),
    ),
  ).toMatchObject({
    result: {
      warnings: [
        'This order expires about 30 seconds after it was prepared (slot 1150); after that it is not sent, and must be prepared again.',
      ],
    },
  })
})

test('a market sell that is not reduce-only says it opens a short', async () => {
  expect(
    await runTradeTool(
      marketOrder,
      { ...buy, side: 'sell', maxSlippageBps: 50 },
      opts(),
    ),
  ).toMatchObject({
    result: {
      summary:
        'Market sell (short): 0.1 SOL perp now, receiving at least $114.58 each; any part that cannot fill at that price is cancelled',
    },
  })
})

test('a market order needs exactly one worst price', async () => {
  for (const input of [buy, { ...buy, maxSlippageBps: 50, limitPrice: '116' }])
    expect(await runTradeTool(marketOrder, input, opts())).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'Give exactly one of maxSlippageBps or limitPrice',
      },
    })
})

test('markets these tools cannot trade are refused before building', async () => {
  const cases = [
    [
      { '/v1/view/exchange/market/SOL': { ...SOL_MARKET, isolatedOnly: true } },
      'SOL trades only in isolated margin, which these tools do not support yet',
    ],
    [
      {
        '/v1/view/exchange/market/SOL': {
          ...SOL_MARKET,
          marketStatus: 'paused',
        },
      },
      "Phoenix's SOL market is paused, not open for orders",
    ],
    [
      { '/v1/view/orderbook/SOL': { ...SOL_BOOK, asks: [] } },
      "Phoenix's SOL book has no asks to fill against",
    ],
  ] as const
  for (const [answers, message] of cases)
    expect(
      await runTradeTool(
        marketOrder,
        { ...buy, maxSlippageBps: 50 },
        opts(answers),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'market_unavailable', message },
    })

  expect(
    await runTradeTool(
      marketOrder,
      { ...buy, symbol: 'NOPE', maxSlippageBps: 50 },
      opts({ '/v1/view/exchange/market/NOPE': 404 }),
    ),
  ).toMatchObject({ ok: false, error: { code: 'not_found' } })
})

test('an order needs an activated account', async () => {
  expect(
    await runTradeTool(
      marketOrder,
      { ...buy, maxSlippageBps: 50 },
      opts({}, rpcFor({ activated: false })),
    ),
  ).toMatchObject({ ok: false, error: { code: 'not_activated' } })
})

test("market accounts that do not match Rise's derivation build nothing", async () => {
  expect(
    await runTradeTool(
      marketOrder,
      { ...buy, maxSlippageBps: 50 },
      opts({
        '/v1/view/exchange/market/SOL': {
          ...SOL_MARKET,
          splinePubkey: SOL_MARKET.marketPubkey,
        },
      }),
    ),
  ).toMatchObject({ ok: false, error: { code: 'check_failed' } })
})

test('a limit order rests with no expiry; a sell rounds up', async () => {
  const outcome = await runTradeTool(
    limitOrder,
    { ...buy, side: 'sell', price: '120.005' },
    opts(),
  )
  expect(packetOf(outcome)).toEqual({
    kind: 'limit',
    side: 'sell',
    priceInTicks: 12001n,
    numBaseLots: 10n,
    minBaseLotsToFill: null,
    lastValidSlot: null,
    reduceOnly: false,
    slide: false,
    cancelExisting: false,
  })
  expect(outcome).toMatchObject({
    result: {
      summary:
        'Limit sell (short): 0.1 SOL perp at $120.01; it rests on the book until filled or cancelled',
      details: { price: '120.01', bestBid: '115.15', notionalUsd: '12.00' },
      trade: {
        action: 'order',
        side: 'sell',
        orderType: 'limit',
        limitPrice: '120.01',
        bestPrice: '115.15',
        notionalUsd: '12.00',
        postOnly: false,
      },
      warnings: [],
    },
  })
})

test('a post-only order never slides, and both kinds warn when crossing', async () => {
  const postOnly = await runTradeTool(
    limitOrder,
    { ...buy, price: '116', postOnly: true },
    opts(),
  )
  expect(packetOf(postOnly)).toMatchObject({ kind: 'post_only', slide: false })
  expect(postOnly).toMatchObject({
    result: {
      warnings: [
        'The price crosses the book (115.16), so Phoenix will reject this post-only order.',
      ],
    },
  })
  expect(
    await runTradeTool(limitOrder, { ...buy, price: '116' }, opts()),
  ).toMatchObject({
    result: {
      warnings: [
        'The price crosses the book (115.16), so this order will fill at once as a taker instead of resting.',
      ],
    },
  })
})

test('crossing is judged in ticks, at the boundary, on both sides', async () => {
  const warningsFor = async (side: string, price: string) => {
    const outcome = await runTradeTool(
      limitOrder,
      { ...buy, side, price },
      opts(),
    )
    if (!outcome.ok || outcome.result.status !== 'ready')
      throw new Error(`unexpected ${JSON.stringify(outcome)}`)
    return outcome.result.warnings.length
  }
  // Best ask 115.16, best bid 115.15.
  expect(await warningsFor('buy', '115.16')).toBe(1)
  expect(await warningsFor('buy', '115.15')).toBe(0)
  expect(await warningsFor('sell', '115.15')).toBe(1)
  expect(await warningsFor('sell', '115.16')).toBe(0)
})
