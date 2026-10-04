import { HeliusError } from './errors'
import {
  array,
  blockTimeToIso,
  integer,
  jsonSafe,
  lamportsToSol,
  number,
  record,
  text,
} from './format'

function accountKey(value: unknown) {
  return text(value) ?? text(record(value).pubkey)
}
export function transactionSummary(
  signature: string,
  value: unknown,
  status: unknown,
  full: boolean,
) {
  const tx = record(value)
  const message = record(record(tx.transaction).message)
  if (
    !Array.isArray(message.accountKeys) ||
    !Array.isArray(message.instructions)
  )
    throw new HeliusError('upstream_error')
  if (
    tx.meta !== null &&
    tx.meta !== undefined &&
    (typeof tx.meta !== 'object' || Array.isArray(tx.meta))
  )
    throw new HeliusError('upstream_error')
  const meta = record(tx.meta)
  const signatureStatus = record(status)
  const hasError =
    Object.hasOwn(meta, 'err') || Object.hasOwn(signatureStatus, 'err')
  const executionError = Object.hasOwn(meta, 'err')
    ? meta.err
    : signatureStatus.err
  const keys = array(message.accountKeys).map(accountKey)
  const instructions = [
    ...array(message.instructions),
    ...array(meta.innerInstructions).flatMap((item) =>
      array(record(item).instructions),
    ),
  ]
  const transfers = instructions.flatMap((item) => {
    const instruction = record(item)
    const parsed = record(instruction.parsed)
    if (!['transfer', 'transferChecked'].includes(text(parsed.type) ?? ''))
      return []
    const info = record(parsed.info)
    const tokenAmount = record(info.tokenAmount)
    return [
      {
        source: text(info.source),
        destination: text(info.destination),
        mint: text(info.mint),
        amount:
          info.lamports !== undefined
            ? lamportsToSol(info.lamports)
            : (text(tokenAmount.uiAmountString) ??
              (info.amount !== undefined
                ? integer(info.amount).toString()
                : null)),
        unit:
          info.lamports !== undefined
            ? 'SOL'
            : tokenAmount.uiAmountString !== undefined
              ? 'token'
              : 'raw',
        decimals: number(tokenAmount.decimals),
      },
    ]
  })
  return {
    signature,
    found: true,
    status: hasError
      ? executionError === null
        ? 'succeeded'
        : 'failed'
      : 'unknown',
    commitment: text(signatureStatus.confirmationStatus),
    time: blockTimeToIso(tx.blockTime),
    slot: jsonSafe(tx.slot ?? signatureStatus.slot ?? null),
    fee_payer: keys[0] ?? null,
    fee_sol: meta.fee === undefined ? null : lamportsToSol(meta.fee),
    transfers,
    programs: [
      ...new Set(
        instructions
          .map((item) => text(record(item).programId))
          .filter((id): id is string => id !== null),
      ),
    ],
    error: jsonSafe(executionError ?? null),
    type: null as string | null,
    description: null as string | null,
    ...(full ? { instructions: jsonSafe(instructions) } : {}),
  }
}
