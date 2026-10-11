import { and, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { signature as toSignature } from '@solana/kit'
import { type } from 'arktype'
import { TransactionReceipt } from '@lanatools/contracts'
import type { TradeSummary } from '@lanatools/contracts'
import { runPhoenixTool } from '@lanatools/phoenix'
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
    size: 'number',
    price: 'number',
    feeUsdc: 'number',
    realizedPnlUsdc: 'number',
    signature: 'string | null',
  }).array(),
})
type PhoenixFill = (typeof PhoenixFills.infer)['trades'][number]

export type TradeFactsReader = {
  transaction: (signature: string) => Promise<ParsedWalletTransaction | null>
  /** The wallet's latest Phoenix fills in one market, newest first. */
  fills: (wallet: string, symbol: string) => Promise<PhoenixFill[]>
}

export function tradeFactsReader(rpc: TransactionRpc): TradeFactsReader {
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
    async fills(wallet, symbol) {
      // Phoenix's largest page; a just-confirmed order is among the newest.
      const outcome = await runPhoenixTool('phoenix_get_history', {
        wallet,
        type: 'trades',
        symbol,
        limit: 100,
      })
      if (!outcome.ok) throw new Error(outcome.error.message)
      return PhoenixFills.assert(outcome.result).trades
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
  return (trade.action === 'order' || trade.action === 'close') && !receipt.fill
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
    const fill = orderFill(
      await reader.fills(row.account, trade.symbol),
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
