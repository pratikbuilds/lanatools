import {
  address,
  blockhash as toBlockhash,
  createSolanaRpc,
  signature as toSignature,
} from '@solana/kit'
import type { Signature } from '@solana/kit'
import { Receipt } from 'mppx'
import type { FixedCharge } from './challenge'
import { RPC_TIMEOUT_MS } from './network'

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/

/**
 * The transaction signature a paid response names, or null. MPP returns a
 * `Payment-Receipt`. Standard x402 returns base64 JSON in `Payment-Response`;
 * pay's gateway puts the raw signature there instead, so both are accepted.
 * Either way the signature is only trusted after it is checked on chain.
 */
export function receiptSignature(
  response: Response,
  protocol: FixedCharge['protocol'],
): string | null {
  try {
    if (protocol === 'mpp') {
      const header = response.headers.get('payment-receipt')
      if (!header) return null
      const receipt = Receipt.deserialize(header)
      return SIGNATURE.test(receipt.reference) ? receipt.reference : null
    }
    const header =
      response.headers.get('payment-response') ??
      response.headers.get('x-payment-response')
    if (!header) return null
    if (SIGNATURE.test(header)) return header
    const settled = JSON.parse(atob(header)) as {
      success?: unknown
      transaction?: unknown
    }
    return settled.success !== false &&
      typeof settled.transaction === 'string' &&
      SIGNATURE.test(settled.transaction)
      ? settled.transaction
      : null
  } catch {
    return null
  }
}

type TokenBalance = {
  owner?: string
  mint: string
  uiTokenAmount: { amount: string }
}

export type Settlement =
  { status: 'paid' } | { status: 'unconfirmed'; reason: string }

/**
 * Waits for the transaction to finalize, then checks that it moved exactly
 * the charged USDC from the payer to the recipient. Anything short of that
 * leaves the payment unconfirmed, so its reservation stays held.
 */
export async function verifySettlement(
  rpcUrl: string,
  signature: string,
  charge: FixedCharge,
  payer: string,
  { timeoutMs = 60_000, intervalMs = 2_000 } = {},
): Promise<Settlement> {
  const rpc = createSolanaRpc(rpcUrl)
  const id = toSignature(signature)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await rpc
      .getSignatureStatuses([id], { searchTransactionHistory: true })
      .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
      .then(({ value }) => value[0])
      .catch(() => null)
    if (status?.err)
      return {
        status: 'unconfirmed',
        reason: 'The transaction failed on chain',
      }
    if (status?.confirmationStatus === 'finalized') break
    if (Date.now() >= deadline)
      return {
        status: 'unconfirmed',
        reason: 'The transaction did not finalize in time',
      }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  const transaction = await rpc
    .getTransaction(id, {
      encoding: 'jsonParsed',
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    })
    .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
    .catch(() => null)
  if (!transaction?.meta || transaction.meta.err)
    return { status: 'unconfirmed', reason: 'Could not read the transaction' }
  const change = (owner: string) =>
    balance(transaction.meta?.postTokenBalances, owner, charge.mint) -
    balance(transaction.meta?.preTokenBalances, owner, charge.mint)
  if (
    change(payer) !== -charge.amount ||
    change(charge.recipient) !== charge.amount
  )
    return {
      status: 'unconfirmed',
      reason: 'The transaction does not match the charged payment',
    }
  return { status: 'paid' }
}

export type ChainOutcome =
  | { status: 'paid'; signature: string; spentAtomic: bigint }
  | { status: 'unpaid' }
  | { status: 'pending' }

const PAGE = 100

/**
 * Where a transaction the wallet signed ended up. While its blockhash is
 * valid it can still land, so the answer is `pending`. Once the blockhash
 * has expired, the wallet's history since `since` holds it or never will:
 * a finalized match that moved the wallet's `mint` is `paid` with what it
 * spent, and no match, or a failed one, is `unpaid`.
 */
// ponytail: scans every wallet transaction since the reservation; index payments by transaction if wallets get busy.
export async function findPayment(
  rpcUrl: string,
  {
    wallet,
    payerSignature,
    blockhash,
    mint,
    since,
  }: {
    wallet: string
    payerSignature: string
    blockhash: string
    mint: string
    since: number
  },
): Promise<ChainOutcome> {
  const rpc = createSolanaRpc(rpcUrl)
  const send = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })
  const { value: valid } = await rpc
    .isBlockhashValid(toBlockhash(blockhash), { commitment: 'processed' })
    .send(send())
  if (valid) return { status: 'pending' }

  let before: Signature | undefined
  for (;;) {
    const page = await rpc
      .getSignaturesForAddress(address(wallet), {
        ...(before ? { before } : {}),
        limit: PAGE,
        commitment: 'confirmed',
      })
      .send(send())
    for (const entry of page) {
      // A minute of slack for the Worker's and the cluster's clocks.
      if (
        entry.blockTime !== null &&
        Number(entry.blockTime) * 1000 < since - 60_000
      )
        return { status: 'unpaid' }
      const transaction = await rpc
        .getTransaction(entry.signature, {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
        .send(send())
      if (
        !transaction?.transaction.signatures.some(
          (signature) => signature === payerSignature,
        )
      )
        continue
      if (transaction.meta?.err) return { status: 'unpaid' }
      if (entry.confirmationStatus !== 'finalized') return { status: 'pending' }
      const spent =
        balance(transaction.meta?.preTokenBalances, wallet, mint) -
        balance(transaction.meta?.postTokenBalances, wallet, mint)
      return spent > 0n
        ? { status: 'paid', signature: entry.signature, spentAtomic: spent }
        : { status: 'unpaid' }
    }
    if (page.length < PAGE) return { status: 'unpaid' }
    before = page[page.length - 1]?.signature
  }
}

function balance(
  balances: readonly TokenBalance[] | undefined,
  owner: string,
  mint: string,
) {
  return (balances ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n)
}
