import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type {
  Address,
  Base64EncodedWireTransaction,
  Instruction,
  Rpc,
  Signature,
  SolanaRpcApi,
} from '@solana/kit'
import { PhoenixError } from '../client'

/**
 * Turns checked instructions into one unsigned v0 transaction, and sends a
 * transaction once someone has signed it. Nothing here holds a key.
 */

export type TradeRpc = Rpc<SolanaRpcApi>

/** The most compute a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000

const RPC_TIMEOUT_MS = 10_000

export type FeeSettings = {
  /** Extra compute over what simulation measured, as a fraction (0.2 = 20%). */
  computeUnitMargin: number
  /** Priority fee; 0n adds no price instruction. */
  microLamportsPerComputeUnit: bigint
}

export type Simulation = {
  ok: boolean
  computeUnits: number
  error?: string
  logs: string[]
}

export type BuiltTransaction = {
  /** Base64 v0 wire transaction with empty signatures. */
  transaction: Base64EncodedWireTransaction
  lastValidBlockHeight: string
  simulation: Simulation
}

const timeout = () => ({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) })

const json = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  )

// Phoenix explains a failure in its last program log line.
function failure(error: unknown, logs: readonly string[]) {
  const reason = [...logs]
    .reverse()
    .find((line) => line.startsWith('Program log: '))
  return reason ? `${json(error)}: ${reason.slice(13)}` : json(error)
}

/**
 * Builds the transaction for `instructions`, paid by `feePayer`. It is
 * simulated once at the maximum compute limit to measure what it uses, then
 * compiled with that measure plus the margin. A failed simulation still
 * returns the transaction, with `simulation.ok` false and Phoenix's reason:
 * the caller decides whether to stop.
 */
export async function buildTransaction(
  rpc: TradeRpc,
  {
    feePayer,
    instructions,
    fees,
  }: {
    feePayer: Address
    instructions: readonly Instruction[]
    fees: FeeSettings
  },
): Promise<BuiltTransaction> {
  if (!(fees.computeUnitMargin >= 0) || fees.microLamportsPerComputeUnit < 0n)
    throw new RangeError('Fee settings must not be negative')
  const { value: latest } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send(timeout())

  const compile = (units: number) =>
    getBase64EncodedWireTransaction(
      compileTransaction(
        pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayer(feePayer, message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(latest, message),
          (message) =>
            appendTransactionMessageInstructions(
              [
                getSetComputeUnitLimitInstruction({ units }),
                ...(fees.microLamportsPerComputeUnit > 0n
                  ? [
                      getSetComputeUnitPriceInstruction({
                        microLamports: fees.microLamportsPerComputeUnit,
                      }),
                    ]
                  : []),
                ...instructions,
              ],
              message,
            ),
        ),
      ),
    )

  const probe = compile(MAX_COMPUTE_UNITS)
  const { value } = await rpc
    .simulateTransaction(probe, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
    })
    .send(timeout())
  const logs = [...(value.logs ?? [])]
  const lastValidBlockHeight = latest.lastValidBlockHeight.toString()
  const used = Number(value.unitsConsumed ?? 0n)

  if (value.err !== null)
    return {
      transaction: probe,
      lastValidBlockHeight,
      simulation: {
        ok: false,
        computeUnits: used,
        error: failure(value.err, logs),
        logs,
      },
    }
  if (used <= 0)
    throw new PhoenixError(
      'upstream_error',
      'The RPC simulated the transaction but reported no compute use',
    )
  const limit = Math.min(
    MAX_COMPUTE_UNITS,
    Math.ceil(used * (1 + fees.computeUnitMargin)),
  )
  return {
    transaction: compile(limit),
    lastValidBlockHeight,
    simulation: { ok: true, computeUnits: used, logs },
  }
}

export type SendResult =
  | { status: 'confirmed'; signature: Signature }
  /** It landed and failed, or the RPC refused it before sending. */
  | { status: 'failed'; signature: Signature; error: string }
  /** Its blockhash expired before it landed: it never will. */
  | { status: 'expired'; signature: Signature }
  /** It may have landed. Check the signature before trying again. */
  | { status: 'unknown'; signature: Signature }

function readSigned(transaction: string) {
  try {
    const decoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(transaction),
    )
    assertIsFullySignedTransaction(decoded)
    return {
      wire: getBase64EncodedWireTransaction(decoded),
      signature: getSignatureFromTransaction(decoded),
    }
  } catch {
    throw new PhoenixError(
      'invalid_input',
      'The transaction is not a fully signed Solana transaction',
    )
  }
}

/**
 * Sends a signed transaction once and waits until it confirms, fails, or its
 * blockhash expires. It never resends or re-signs: a send whose outcome is
 * unclear comes back `unknown` with its signature, because a second send
 * could trade twice.
 */
export async function sendSignedTransaction(
  rpc: TradeRpc,
  {
    transaction,
    lastValidBlockHeight,
  }: { transaction: string; lastValidBlockHeight: string },
  { intervalMs = 2_000 } = {},
): Promise<SendResult> {
  const { wire, signature } = readSigned(transaction)
  const lastValid = BigInt(lastValidBlockHeight)

  try {
    await rpc
      .sendTransaction(wire, {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
      })
      .send(timeout())
  } catch (error) {
    // Preflight refused it, so it was never broadcast.
    if (
      isSolanaError(
        error,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    )
      return {
        status: 'failed',
        signature,
        error: `The RPC refused the transaction in simulation: ${error.cause instanceof Error ? error.cause.message : error.message}`,
      }
    return { status: 'unknown', signature }
  }

  try {
    for (;;) {
      const {
        value: [status],
      } = await rpc.getSignatureStatuses([signature]).send(timeout())
      if (status?.err)
        return { status: 'failed', signature, error: json(status.err) }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      )
        return { status: 'confirmed', signature }
      const height = await rpc
        .getBlockHeight({ commitment: 'confirmed' })
        .send(timeout())
      if (height > lastValid) {
        // It may have landed in the last valid blocks.
        const {
          value: [last],
        } = await rpc
          .getSignatureStatuses([signature], { searchTransactionHistory: true })
          .send(timeout())
        if (!last) return { status: 'expired', signature }
        if (last.err)
          return { status: 'failed', signature, error: json(last.err) }
        if (
          last.confirmationStatus === 'confirmed' ||
          last.confirmationStatus === 'finalized'
        )
          return { status: 'confirmed', signature }
        return { status: 'unknown', signature }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  } catch {
    return { status: 'unknown', signature }
  }
}
