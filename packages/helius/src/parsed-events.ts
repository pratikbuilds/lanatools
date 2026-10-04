import { HeliusError } from './errors'
import {
  array,
  blockTimeToIso,
  decimalAmount,
  jsonSafe,
  lamportsToSol,
  number,
  record,
  text,
} from './format'
import { netBalanceChanges } from './transactions'

/** Parsed Events has an item envelope; it is not the legacy Enhanced API. */
export function parsedTransactionSummary(
  result: unknown,
  full: boolean,
): Record<string, unknown> {
  const item = record(result)
  const signature = text(item.signature)
  if (!signature) throw new HeliusError('upstream_error')
  if (item.parserStatus === 'ERROR') {
    if (record(item.parserError).code === 'transaction_not_found')
      return { signature, found: false }
    // A parser/fetch error does not establish whether a transaction is missing.
    // Never forward a provider error message, which may echo credentials.
    return {
      signature,
      found: null,
      status: 'unknown',
      time: null,
      fee_sol: null,
      type: null,
      description: null,
      net_balance_changes: null,
      parser_error: {
        code: 'upstream_error',
        message: 'The transaction could not be parsed.',
      },
    }
  }
  const parsed = record(item.parsed)
  if (
    item.parserStatus !== 'OK' ||
    !['OK', 'ERROR'].includes(String(parsed.transactionStatus))
  )
    throw new HeliusError('upstream_error')
  const summary = record(parsed.summary)
  const instructions = array(parsed.instructions)
  const transfers = [
    ...array(parsed.nativeTransfers).map((value) => {
      const transfer = record(value)
      return {
        source: text(transfer.fromUserAccount),
        destination: text(transfer.toUserAccount),
        mint: null,
        amount: lamportsToSol(transfer.amount),
        unit: 'SOL',
        decimals: 9,
      }
    }),
    ...array(parsed.tokenTransfers).map((value) => {
      const transfer = record(value)
      const decimals = number(transfer.decimals)
      if (decimals === null) throw new HeliusError('upstream_error')
      return {
        source: text(transfer.fromUserAccount),
        destination: text(transfer.toUserAccount),
        source_token_account: text(transfer.fromTokenAccount),
        destination_token_account: text(transfer.toTokenAccount),
        mint: text(transfer.mint),
        amount: decimalAmount(transfer.rawTokenAmount, decimals),
        unit: 'token',
        decimals,
      }
    }),
  ]
  const raw = record(item.rawTransaction)
  const meta = record(raw.meta)
  const hasRawBalances =
    Array.isArray(meta.preBalances) &&
    Array.isArray(meta.postBalances) &&
    Array.isArray(record(record(raw.transaction).message).accountKeys)
  return {
    signature,
    found: true,
    status: parsed.transactionStatus === 'ERROR' ? 'failed' : 'succeeded',
    commitment: 'confirmed',
    time: blockTimeToIso(parsed.blockTime),
    slot: jsonSafe(parsed.slot ?? null),
    fee_payer: text(parsed.feePayer),
    fee_sol: parsed.fee === undefined ? null : lamportsToSol(parsed.fee),
    transfers,
    programs: [
      ...new Set(
        instructions
          .map((value) => text(record(value).programId))
          .filter((id): id is string => id !== null),
      ),
    ],
    error: jsonSafe(parsed.error ?? null),
    type: text(summary.type),
    description: text(summary.description),
    // Transfers omit fees/rent and cannot reconstruct an exact balance delta.
    net_balance_changes: hasRawBalances ? netBalanceChanges(raw) : null,
    ...(full ? { instructions: jsonSafe(instructions) } : {}),
  }
}

export function parsedTransactions(
  value: unknown,
  signatures: readonly string[],
  full: boolean,
) {
  if (!Array.isArray(value) || value.length !== signatures.length)
    throw new HeliusError('upstream_error')
  return value.map((item, index) => {
    // The API promises input order, including duplicate signatures. Reject
    // broken order rather than attaching another transaction to a signature.
    if (record(item).signature !== signatures[index])
      throw new HeliusError('upstream_error')
    return parsedTransactionSummary(item, full)
  })
}
