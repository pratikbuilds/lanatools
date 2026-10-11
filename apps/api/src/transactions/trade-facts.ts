import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { signature as toSignature } from '@solana/kit'
import { type } from 'arktype'
import { TransactionReceipt } from '@lanatools/contracts'
import type { TradeSummary } from '@lanatools/contracts'
import { runPhoenixTool } from '@lanatools/phoenix'
import type { PhoenixOpts } from '@lanatools/phoenix'
import { transactionRequest } from '../db/schema'
import type { TransactionRequestRow } from './requests'
import type { TransactionRpc } from './submission'
import { parseWalletTransaction, walletChanges } from './wallet-transfers'
import type { ParsedWalletTransaction } from './wallet-transfers'

/**
 * What a confirmed trade actually did, read once after confirmation: a
 * swap's net output to the signer and a perp order's fills on Phoenix. The
 * review only knows estimates and price bounds.
 */

const WRAPPED_SOL = 'So11111111111111111111111111111111111111112'

const PhoenixFills = type({
  trades: type({
    time: 'string',
    size: 'number',
    price: 'number',
    feeUsdc: 'number',
    realizedPnlUsdc: 'number',
    signature: 'string | null',
  }).array(),
  nextCursor: 'string | null',
})
type PhoenixFill = (typeof PhoenixFills.infer)['trades'][number]

export type TradeFactsReader = {
  transaction: (signature: string) => Promise<ParsedWalletTransaction | null>
  /**
   * The wallet's Phoenix fills in one market, newest first, back to at
   * least `since` (Unix ms), so an older order's fills are all included.
   */
  fills: (
    wallet: string,
    symbol: string,
    since: number,
  ) => Promise<PhoenixFill[]>
}

export function tradeFactsReader(
  rpc: TransactionRpc,
  phoenix: PhoenixOpts = {},
): TradeFactsReader {
  return {
    async transaction(value) {
      const tx = await rpc.accounts
        .getTransaction(toSignature(value), {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
        .send({ abortSignal: AbortSignal.timeout(5_000) })
      return tx ? parseWalletTransaction(tx) : null
    },
    async fills(wallet, symbol, since) {
      const fills: PhoenixFill[] = []
      let cursor: string | null = null
      // Page back (Phoenix's largest page each time) until the history is
      // older than `since`, so the order's fills are all in, even across a
      // page boundary.
      do {
        const outcome = await runPhoenixTool(
          'phoenix_get_history',
          {
            wallet,
            type: 'trades',
            symbol,
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
          phoenix,
        )
        if (!outcome.ok) throw new Error(outcome.error.message)
        const page = PhoenixFills.assert(outcome.result)
        fills.push(...page.trades)
        const oldest = page.trades.at(-1)
        if (!oldest || Date.parse(oldest.time) < since) break
        cursor = page.nextCursor
      } while (cursor)
      return fills
    },
  }
}

/** A decimal string from base units, without trailing zeros. */
function decimal(units: bigint, decimals: number) {
  const negative = units < 0n
  const digits = (negative ? -units : units)
    .toString()
    .padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

/** Phoenix reports floats; keep what it shows, without float noise. */
const tidy = (value: number) => Number(value.toPrecision(12)).toString()

/** The signer's net change in the swap's output, once confirmed. */
export function swapReceived(
  tx: ParsedWalletTransaction,
  wallet: string,
  mint: string,
) {
  const changes = walletChanges(tx, wallet)
  // SOL output usually arrives unwrapped, as lamports.
  const change =
    changes.find((each) => each.mint === mint) ??
    (mint === WRAPPED_SOL
      ? changes.find((each) => each.mint === 'native')
      : undefined)
  if (!change || change.delta <= 0n) return null
  return { mint, amount: decimal(change.delta, change.decimals) }
}

/** One order's fills, summed: size, average price, fees and realized PnL. */
export function orderFill(fills: PhoenixFill[], signature: string) {
  const mine = fills.filter((fill) => fill.signature === signature)
  const size = mine.reduce((sum, fill) => sum + fill.size, 0)
  if (mine.length === 0 || size <= 0) return null
  const sum = (key: 'feeUsdc' | 'realizedPnlUsdc') =>
    tidy(mine.reduce((total, fill) => total + fill[key], 0))
  return {
    size: tidy(size),
    price: tidy(
      mine.reduce((total, fill) => total + fill.size * fill.price, 0) / size,
    ),
    feeUsdc: sum('feeUsdc'),
    realizedPnlUsdc: sum('realizedPnlUsdc'),
  }
}

/** Whether a confirmed trade still lacks the facts it can have. */
export function needsTradeFacts(
  trade: TradeSummary | undefined,
  receipt: TransactionReceipt | null,
) {
  if (!trade || !receipt) return false
  if (trade.kind === 'swap') return !receipt.received
  // Market orders and closes fill inside their own transaction; a limit
  // order rests and fills later in others, so its own signature never has
  // a fill to find.
  const immediate =
    trade.action === 'close' ||
    (trade.action === 'order' && trade.orderType === 'market')
  return immediate && !receipt.fill
}

/**
 * Reads and stores a confirmed trade's facts. Best effort: a transaction or
 * fill that cannot be read yet leaves the receipt as it was, and the next
 * read tries again.
 */
export async function settleTradeFacts(
  database: D1Database,
  row: TransactionRequestRow,
  trade: TradeSummary | undefined,
  reader: TradeFactsReader,
) {
  if (row.status !== 'confirmed' || !row.signature || !row.account) return
  const receipt = row.receiptJson
    ? TransactionReceipt.assert(JSON.parse(row.receiptJson))
    : null
  if (!receipt || !trade || !needsTradeFacts(trade, receipt)) return
  let facts: Partial<TransactionReceipt> | null = null
  if (trade.kind === 'swap') {
    const tx = await reader.transaction(row.signature)
    const received = tx && swapReceived(tx, row.account, trade.receive.mint)
    if (received) facts = { received }
  } else if (trade.symbol) {
    // The request exists before its transaction is sent, so its fills are
    // never older than it.
    const fill = orderFill(
      await reader.fills(row.account, trade.symbol, row.createdAt),
      row.signature,
    )
    if (fill) facts = { fill }
  }
  if (!facts) return
  await drizzle(database)
    .update(transactionRequest)
    .set({ receiptJson: JSON.stringify({ ...receipt, ...facts }) })
    .where(
      and(
        eq(transactionRequest.id, row.id),
        eq(transactionRequest.status, 'confirmed'),
        eq(transactionRequest.signature, row.signature),
      ),
    )
    .run()
}
