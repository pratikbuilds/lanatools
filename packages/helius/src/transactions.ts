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
  const messageData = record(record(tx.transaction).message)
  if (
    !Array.isArray(messageData.accountKeys) ||
    !Array.isArray(messageData.instructions)
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
  const message = record(record(tx.transaction).message)
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
    commitment: text(record(status).confirmationStatus),
    time: blockTimeToIso(tx.blockTime),
    slot: jsonSafe(tx.slot ?? record(status).slot ?? null),
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
export function netBalanceChanges(value: unknown) {
  const tx = record(value)
  const meta = record(tx.meta)
  const keys = array(record(record(tx.transaction).message).accountKeys).map(
    accountKey,
  )
  // JSON raw transactions store lookup-table keys separately; jsonParsed
  // transactions already expand them into accountKeys.
  if (keys.length < array(meta.preBalances).length) {
    const loaded = record(meta.loadedAddresses)
    keys.push(
      ...array(loaded.writable).map(accountKey),
      ...array(loaded.readonly).map(accountKey),
    )
  }
  const pre = array(meta.preBalances)
  const post = array(meta.postBalances)
  if (
    !Array.isArray(meta.preBalances) ||
    !Array.isArray(meta.postBalances) ||
    pre.length !== post.length ||
    keys.length !== pre.length ||
    keys.some((key) => !key)
  )
    throw new HeliusError('upstream_error')
  const sol = keys.flatMap((id, i) => {
    if (!id || pre[i] === undefined || post[i] === undefined) return []
    const delta = integer(post[i]) - integer(pre[i])
    return delta === 0n
      ? []
      : [{ address: id, change_sol: lamportsToSol(delta) }]
  })
  const preTokens = meta.preTokenBalances
  const postTokens = meta.postTokenBalances
  for (const entries of [preTokens, postTokens])
    if (entries !== undefined && entries !== null && !Array.isArray(entries))
      throw new HeliusError('upstream_error')
  // Unavailable token metadata is not a zero balance. Older transactions may
  // lack recording, while explicit empty arrays still establish zero tokens.
  if (!Array.isArray(preTokens) || !Array.isArray(postTokens))
    return { sol, tokens: null }
  const tokens = new Map<
    string,
    {
      owner: string | null
      mint: string | null
      account_index: number | null
      decimals: number | null
      before: bigint
      after: bigint
    }
  >()
  for (const [side, entries] of [
    ['before', preTokens],
    ['after', postTokens],
  ] as const) {
    for (const entry of entries) {
      const item = record(entry)
      const amount = record(item.uiTokenAmount)
      const key = `${String(item.accountIndex)}:${String(item.mint)}`
      const current = tokens.get(key) ?? {
        owner: text(item.owner),
        mint: text(item.mint),
        account_index: number(item.accountIndex),
        decimals: number(amount.decimals),
        before: 0n,
        after: 0n,
      }
      current[side] = integer(amount.amount)
      current.owner ??= text(item.owner)
      tokens.set(key, current)
    }
  }
  return {
    sol,
    tokens: [...tokens.values()]
      .filter((item) => item.before !== item.after)
      .map(({ before, after, ...item }) => ({
        ...item,
        change_raw: (after - before).toString(),
      })),
  }
}
