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
    lastValidSlot: 1_016n,
    reduceOnly: false,
    slide: false,
    cancelExisting: false,
  })
  expect(outcome).toMatchObject({
    ok: true,
    result: {
      summary:
        'Buy 0.1 SOL now at at most $115.73 each (market order); any part that cannot fill at that price is cancelled',
      details: {
        limitPrice: '115.73',
        bestPrice: '115.16',
        estimatedNotionalUsd: '11.52',
        estimatedTakerFeeUsd: '0.00',
        expiresAfterSlot: '1016',
      },
      warnings: [],
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
      warnings: [
        'The limit is above the best bid (115.15), so this order will not fill now.',
      ],
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
        'Place a limit sell of 0.1 SOL at $120.01; it rests on the book until filled or cancelled',
      details: { price: '120.01', bestBid: '115.15', notionalUsd: '12.00' },
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
