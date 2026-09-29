import { Receipt } from 'mppx'
import type { FixedCharge } from './challenge'
import { rpc } from './network'

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
type ParsedTransaction = {
  meta: {
    err: unknown
    preTokenBalances?: TokenBalance[]
    postTokenBalances?: TokenBalance[]
  } | null
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
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { value } = await rpc<{
      value: Array<{ confirmationStatus?: string; err: unknown } | null>
    }>(rpcUrl, 'getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: true },
    ]).catch(() => ({ value: [null] }))
    const status = value[0]
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

  const transaction = await rpc<ParsedTransaction | null>(
    rpcUrl,
    'getTransaction',
    [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      },
    ],
  ).catch(() => null)
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

function balance(
  balances: TokenBalance[] | undefined,
  owner: string,
  mint: string,
) {
  return (balances ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n)
}
