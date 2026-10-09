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
import {
  PHOENIX_PROGRAM,
  cancelData,
  decodeOrder,
  traderAccountAddress,
} from '../rise'
import { runTradeTool } from '../tool'
import type { TradeOutcome } from '../tool'
import { messageOf } from '../transaction'
import { cancelOrders } from './cancel'
import { closePosition } from './close'

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }
const TRADER = await traderAccountAddress(WALLET)

const rpc = () =>
  fakeRpc({
    getAccountInfo: (account) =>
      account === TRADER
        ? accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA)
        : { value: null },
    getSlot: () => 1_000n,
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 300_000n, logs: [] },
    }),
  }).rpc

const order = (
  id: string,
  priceTicks: string,
  change: string | null = null,
) => ({
  orderSequenceNumber: id,
  priceTicks,
  priceUsd: String(Number(priceTicks) / 100),
  side: 'bid',
  sizeRemainingLots: '10',
  change,
})

/** Phoenix's trader state for WALLET's cross account. */
const state = ({
  orders = [
    order('7', '5000'),
    order('9', '5100'),
    order('11', '5200', 'closed'),
  ],
  basePositionLots = '0',
} = {}) => ({
  authority: WALLET,
  snapshot: {
    subaccounts: [
      {
        subaccountIndex: 0,
        collateral: '0',
        positions: [{ symbol: 'SOL', basePositionLots }],
        orders: [{ symbol: 'SOL', orders }],
      },
      // Isolated subaccounts are never touched.
      {
        subaccountIndex: 3,
        positions: [{ symbol: 'SOL', basePositionLots: '500' }],
        orders: [{ symbol: 'SOL', orders: [order('99', '9000')] }],
      },
    ],
  },
})

const opts = (answers: Record<string, unknown>) => ({
  rpc: rpc(),
  fees: FEES,
  fetch: fakePhoenix({
    '/v1/view/exchange/market/SOL': SOL_MARKET,
    '/v1/view/orderbook/SOL': SOL_BOOK,
    '/v1/view/exchange/keys': KEYS,
    [`/v1/trader/state/${WALLET}`]: state(),
    ...answers,
  }).fetch,
})

/** The last instruction's data in a ready result's transaction. */
function dataOf(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  const instruction = messageOf(outcome.result.transaction).instructions.at(-1)
  return Uint8Array.from(instruction?.data ?? [])
}

test('orders are cancelled by ID at their own price', async () => {
  const outcome = await runTradeTool(
    cancelOrders,
    { wallet: WALLET, symbol: 'SOL', orderIds: ['9', '9'] },
    opts({}),
  )
  expect(dataOf(outcome)).toEqual(
    cancelData([{ priceInTicks: 5100n, orderSequenceNumber: 9n }]),
  )
  expect(outcome).toMatchObject({
    result: {
      summary: 'Cancel 1 resting SOL order',
      details: { 'order 9': 'bid 0.1 at $51' },
      warnings: [],
    },
  })
})

test('without IDs every resting order in the market is cancelled', async () => {
  const outcome = await runTradeTool(
    cancelOrders,
    { wallet: WALLET, symbol: 'SOL' },
    opts({}),
  )
  expect(dataOf(outcome)).toEqual(cancelData(null))
  expect(outcome).toMatchObject({
    result: {
      // The closed row is gone from the book; the isolated account's order
      // is not ours to cancel here.
      summary: 'Cancel all 2 resting SOL orders in the cross-margin account',
      details: { 'order 7': 'bid 0.1 at $50', 'order 9': 'bid 0.1 at $51' },
      warnings: [
        'This cancels every resting order the account has in this market when it lands, including any placed after this was prepared.',
      ],
    },
  })
})

test('an order that is not resting, or no orders at all, is not found', async () => {
  for (const ids of [['11'], ['99'], ['12']])
    expect(
      await runTradeTool(
        cancelOrders,
        { wallet: WALLET, symbol: 'SOL', orderIds: ids },
        opts({}),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: `No resting SOL order ${ids[0]}; open order IDs: 7, 9`,
      },
    })
  expect(
    await runTradeTool(
      cancelOrders,
      { wallet: WALLET, symbol: 'SOL' },
      opts({ [`/v1/trader/state/${WALLET}`]: state({ orders: [] }) }),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'not_found',
      message: 'This account has no resting SOL orders',
    },
  })
  expect(
    await runTradeTool(
      cancelOrders,
      { wallet: WALLET, symbol: 'SOL' },
      opts({ [`/v1/trader/state/${WALLET}`]: 404 }),
    ),
  ).toMatchObject({ ok: false, error: { code: 'not_activated' } })
})

const close = (input: Record<string, unknown>, basePositionLots: string) =>
  runTradeTool(
    closePosition,
    { wallet: WALLET, symbol: 'SOL', ...input },
    opts({
      [`/v1/trader/state/${WALLET}`]: state({ basePositionLots }),
    }),
  )

test('closing part of a long is a reduce-only sell of that share', async () => {
  const outcome = await close({ fraction: 0.5, maxSlippageBps: 50 }, '25')
  // Half of 25 lots rounds down to 12; the sell limit is below the best bid.
  expect(decodeOrder(dataOf(outcome))).toMatchObject({
    kind: 'market',
    side: 'sell',
    numBaseLots: 12n,
    priceInTicks: 11458n,
    reduceOnly: true,
    lastValidSlot: 1_150n,
  })
  expect(outcome).toMatchObject({
    result: {
      expiresAfterSlot: '1150',
      position: { symbol: 'SOL', assetId: 0, baseLotsDecimals: 2 },
      summary:
        'Close 0.12 of the 0.25 SOL long: market sell now, receiving at least $114.58 each; reduce-only, so it can never open a short',
      details: { position: 'long 0.25', closing: '0.12' },
    },
  })
})

test('closing a short is a reduce-only buy of all of it by default', async () => {
  const outcome = await close({ limitPrice: '116' }, '-30')
  expect(decodeOrder(dataOf(outcome))).toMatchObject({
    side: 'buy',
    numBaseLots: 30n,
    priceInTicks: 11600n,
    reduceOnly: true,
  })
  expect(outcome).toMatchObject({
    result: {
      summary:
        'Close 0.3 of the 0.3 SOL short: market buy now, paying at most $116 each; reduce-only, so it can never open a long',
    },
  })
})

test('a close needs a position, a share of at least one lot, and one worst price', async () => {
  expect(await close({ maxSlippageBps: 50 }, '0')).toMatchObject({
    ok: false,
    error: {
      code: 'not_found',
      message: 'This account has no open SOL position',
    },
  })
  expect(await close({ fraction: 0.4, maxSlippageBps: 50 }, '2')).toMatchObject(
    {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'fraction leaves less than one lot of the position to close',
      },
    },
  )
  for (const input of [{}, { maxSlippageBps: 50, limitPrice: '116' }])
    expect(await close(input, '25')).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'Give exactly one of maxSlippageBps or limitPrice',
      },
    })
  expect(
    await close({ fraction: 1.5, maxSlippageBps: 50 }, '25'),
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
})
