import { and, eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { type } from 'arktype'
import type {
  PhoenixCandleInterval,
  PhoenixCandles,
  PhoenixFills,
} from '@lanatools/contracts'
import { runPhoenixTool } from '@lanatools/phoenix'
import type { PhoenixOpts } from '@lanatools/phoenix'
import { mcpGrant, transactionRequest } from '../db/schema'

/**
 * Phoenix reads for the dashboard's account page. Phoenix's data is
 * public, so any address can be read; only `placedBy` uses the signed-in
 * user's own transactions.
 */

/**
 * Candles per chart: Phoenix's most per request, so each interval reaches
 * as far back as one read allows (daily about 16 months, 15m about 5 days).
 */
const CANDLES_PER_CHART = 500

/** Fills per page, as the Transactions tab pages its ledger. */
export const PHOENIX_FILLS_PAGE = 50

const CandleResult = type({
  candles: type({
    time: 'string',
    open: 'number',
    high: 'number',
    low: 'number',
    close: 'number',
  }).array(),
})

const FillsResult = type({
  trades: type({
    time: 'string',
    symbol: 'string',
    side: "'buy' | 'sell'",
    size: 'number',
    price: 'number',
    feeUsdc: 'number',
    realizedPnlUsdc: 'number',
    signature: 'string | null',
  }).array(),
  nextCursor: 'string | null',
})

/** Phoenix's error, without its raw body. */
export class PhoenixReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function read(name: string, input: unknown, opts: PhoenixOpts) {
  const outcome = await runPhoenixTool(name, input, opts)
  if (!outcome.ok)
    throw new PhoenixReadError(outcome.error.code, outcome.error.message)
  return outcome.result
}

export async function phoenixCandles(
  symbol: string,
  interval: PhoenixCandleInterval,
  opts: PhoenixOpts = {},
): Promise<PhoenixCandles> {
  const result = CandleResult.assert(
    await read(
      'phoenix_get_candles',
      { symbol, timeframe: interval, limit: CANDLES_PER_CHART },
      opts,
    ),
  )
  return {
    symbol,
    interval,
    candles: result.candles.map(({ time, open, high, low, close }) => ({
      time: Math.floor(Date.parse(time) / 1000),
      open,
      high,
      low,
      close,
    })),
  }
}

/** Phoenix reports floats; keep what it shows, without float noise. */
const tidy = (value: number) => Number(value.toPrecision(12)).toString()

export async function phoenixFills(
  database: D1Database,
  userId: string,
  wallet: string,
  cursor: string | undefined,
  opts: PhoenixOpts = {},
): Promise<PhoenixFills> {
  const result = FillsResult.assert(
    await read(
      'phoenix_get_history',
      {
        wallet,
        type: 'trades',
        limit: PHOENIX_FILLS_PAGE,
        ...(cursor ? { cursor } : {}),
      },
      opts,
    ),
  )
  const signatures = [
    ...new Set(
      result.trades.flatMap((trade) =>
        trade.signature ? [trade.signature] : [],
      ),
    ),
  ]
  // Only the user's own requests are matched, so another user's client
  // name never shows here.
  const placed = signatures.length
    ? await drizzle(database)
        .select({
          signature: transactionRequest.signature,
          clientName: mcpGrant.clientName,
        })
        .from(transactionRequest)
        .leftJoin(
          mcpGrant,
          and(
            eq(mcpGrant.privyUserId, transactionRequest.creatorUserId),
            eq(mcpGrant.clientId, transactionRequest.creatorClientId),
          ),
        )
        .where(
          and(
            eq(transactionRequest.creatorUserId, userId),
            inArray(transactionRequest.signature, signatures),
          ),
        )
        .all()
    : []
  const clientOf = new Map(
    placed.map((row) => [row.signature, row.clientName ?? 'Unknown client']),
  )
  return {
    fills: result.trades.map((trade) => ({
      time: Date.parse(trade.time),
      symbol: trade.symbol,
      side: trade.side,
      size: tidy(trade.size),
      price: tidy(trade.price),
      feeUsdc: tidy(trade.feeUsdc),
      realizedPnlUsdc: tidy(trade.realizedPnlUsdc),
      signature: trade.signature,
      placedBy: (trade.signature && clientOf.get(trade.signature)) ?? null,
    })),
    nextCursor: result.nextCursor,
  }
}
