import { type } from 'arktype'

const Lamports = type('string').narrow(
  (value, ctx) =>
    (/^\d{1,20}$/.test(value) &&
      BigInt(value) > 0n &&
      BigInt(value) <= 18446744073709551615n) ||
    ctx.reject('a positive u64 amount in lamports'),
)

const TransferFields = {
  '+': 'reject',
  action: "'transfer_sol'",
  idempotencyKey: '1 <= string <= 128',
  recipient: '32 <= string <= 44',
  amountLamports: Lamports,
} as const

/** Named intent only. Wallet IDs and instructions are never caller inputs. */
export const TransactionInput = type({
  ...TransferFields,
  execution: "'embedded'",
}).or({
  ...TransferFields,
  execution: "'external'",
  externalWallet: 'string | null',
})
export type TransactionInput = typeof TransactionInput.infer

export const ATTEMPT_STATES = [
  'preparing',
  'prepared',
  'issued',
  'signing',
  'signed',
  'submitting',
  'submitted',
  'uncertain',
  'succeeded',
  'failed',
  'expired',
  'abandoned',
] as const
export type AttemptState = (typeof ATTEMPT_STATES)[number]

/** Safe to return to an agent; excludes message bytes and claim tokens. */
export type TransactionResult = {
  requestId: string
  state: 'requested' | 'refused' | AttemptState
  attemptId: string | null
  signature: string | null
  reason: string | null
}

/** Trusted adapters validate the final message before returning this shape. */
export type PreparedTransaction = {
  walletAddress: string
  network: 'devnet' | 'mainnet'
  messageBase64: string
  preparationSlot: string
  blockhash: string
  lastValidBlockHeight: string
}

/** Evidence is supplied by the trusted verifier, never an agent assertion. */
export type TransactionEvidence =
  | { kind: 'rpc_accepted'; signature: string }
  | { kind: 'transport_unknown'; reason: string }
  | {
      kind: 'chain_success' | 'chain_failure'
      signature: string
      slot: string
      commitment: 'confirmed' | 'finalized'
      reason: string | null
    }
  | {
      kind: 'expiry_reconciled'
      checkedBlockHeight: string
      historyChecked: true
    }
