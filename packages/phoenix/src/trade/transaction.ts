import {
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  appendTransactionMessageInstructions,
  assertIsFullySignedTransaction,
  blockhash as toBlockhash,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from '@solana/kit'
import type {
  Address,
  Base64EncodedWireTransaction,
  Blockhash,
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

export const rpcTimeout = () => ({
  abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS),
})

export const json = (value: unknown) =>
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
 * The fee payer and instructions of a wire transaction, for checking one
 * that was built elsewhere (Rise builds activation whole).
 */
export function messageOf(transaction: string) {
  const decoded = getTransactionDecoder().decode(
    getBase64Encoder().encode(transaction),
  )
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(decoded.messageBytes),
  )
  return {
    wire: getBase64EncodedWireTransaction(decoded),
    feePayer: message.feePayer.address,
    instructions: message.instructions,
  }
}

/**
 * Simulates an unsigned transaction exactly as built: no signature checks,
 * its own blockhash.
 */
export async function simulateTransaction(
  rpc: TradeRpc,
  transaction: Base64EncodedWireTransaction,
): Promise<Simulation> {
  const { value } = await rpc
    .simulateTransaction(transaction, {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
    })
    .send(rpcTimeout())
  const logs = [...(value.logs ?? [])]
  const computeUnits = Number(value.unitsConsumed ?? 0n)
  if (value.err !== null)
    return {
      ok: false,
      computeUnits,
      error: failure(value.err, logs),
      logs,
    }
  if (computeUnits <= 0)
    throw new PhoenixError(
      'upstream_error',
      'The RPC simulated the transaction but reported no compute use',
    )
  return { ok: true, computeUnits, logs }
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
    .send(rpcTimeout())

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
  const simulation = await simulateTransaction(rpc, probe)
  const lastValidBlockHeight = latest.lastValidBlockHeight.toString()
  if (!simulation.ok)
    return { transaction: probe, lastValidBlockHeight, simulation }
  const limit = Math.min(
    MAX_COMPUTE_UNITS,
    Math.ceil(simulation.computeUnits * (1 + fees.computeUnitMargin)),
  )
  return { transaction: compile(limit), lastValidBlockHeight, simulation }
}

export type SendResult =
  | { status: 'confirmed'; signature: Signature }
  /** It landed and failed, or the RPC refused it before sending. */
  | { status: 'failed'; signature: Signature; error: string }
  /** Its blockhash or order expired before it landed: it never will. */
  | { status: 'expired'; signature: Signature; error?: string }
  /** It may have landed. Check the signature before trying again. */
  | { status: 'unknown'; signature: Signature; error?: string }

/**
 * A signed transaction, checked: it carries exactly the message that was
 * prepared, and the fee payer's signature is present and valid. Phoenix
 * co-signs activation itself, so that route needs only the fee payer's;
 * every other route needs every signature.
 */
export async function readSigned(
  transaction: string,
  { prepared, complete = true }: { prepared: string; complete?: boolean },
) {
  let decoded
  let unsigned
  try {
    decoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(transaction),
    )
    unsigned = getTransactionDecoder().decode(
      getBase64Encoder().encode(prepared),
    )
  } catch {
    throw new PhoenixError('invalid_input', 'The transaction does not decode')
  }
  const sameMessage =
    decoded.messageBytes.length === unsigned.messageBytes.length &&
    decoded.messageBytes.every(
      (byte, index) => byte === unsigned.messageBytes[index],
    )
  if (!sameMessage)
    throw new PhoenixError(
      'invalid_input',
      'The signed transaction is not the one that was prepared; nothing was sent',
    )
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  )
  const feePayer = message.staticAccounts[0]
  const signatureBytes = feePayer ? decoded.signatures[feePayer] : null
  const valid =
    feePayer &&
    signatureBytes &&
    (await verifySignature(
      await getPublicKeyFromAddress(feePayer),
      signatureBytes,
      decoded.messageBytes,
    ))
  if (!valid)
    throw new PhoenixError(
      'invalid_input',
      'The transaction is not signed by its fee payer; nothing was sent',
    )
  if (complete) {
    try {
      assertIsFullySignedTransaction(decoded)
    } catch {
      throw new PhoenixError(
        'invalid_input',
        'The transaction is not fully signed; nothing was sent',
      )
    }
  }
  return {
    wire: getBase64EncodedWireTransaction(decoded),
    signature: getSignatureFromTransaction(decoded),
    blockhash: toBlockhash(message.lifetimeToken),
  }
}

const ALREADY_PROCESSED = SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED

/**
 * Sends a signed transaction once and waits until it confirms, fails, or its
 * blockhash expires. It never resends or re-signs. A send whose outcome is
 * unclear is still watched, since watching never sends: it ends `unknown`
 * only when the cluster cannot say. The caller must not send it again before
 * checking the signature, because a second trade could fill.
 */
export async function sendSignedTransaction(
  rpc: TradeRpc,
  {
    prepared,
    transaction,
    lastValidBlockHeight,
    expiresAfterSlot,
  }: {
    prepared: string
    transaction: string
    lastValidBlockHeight: string
    /** An order's expiry: past it, Phoenix would ignore the order. */
    expiresAfterSlot?: string | undefined
  },
  { intervalMs = 2_000 } = {},
): Promise<SendResult> {
  const { wire, signature, blockhash } = await readSigned(transaction, {
    prepared,
  })
  if (expiresAfterSlot !== undefined) {
    const slot = await rpc
      .getSlot({ commitment: 'processed' })
      .send(rpcTimeout())
    // Phoenix treats an expired order as a no-op that still succeeds: the
    // fee would buy nothing.
    if (slot > BigInt(expiresAfterSlot))
      return {
        status: 'expired',
        signature,
        error: `The order expired at slot ${expiresAfterSlot} before it was sent (now ${slot}); nothing was sent. Prepare it again.`,
      }
  }
  const watch = () =>
    waitForConfirmation(rpc, {
      signature,
      blockhash,
      lastValidBlockHeight,
      intervalMs,
    })

  try {
    await rpc
      .sendTransaction(wire, {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
      })
      .send(rpcTimeout())
  } catch (error) {
    if (
      isSolanaError(
        error,
        SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
      )
    ) {
      // These exact bytes already landed (a resend after `unknown`).
      if (isSolanaError(error.cause, ALREADY_PROCESSED)) return watch()
      // Preflight refused it, so it was never broadcast.
      return {
        status: 'failed',
        signature,
        error: `The RPC refused the transaction in simulation: ${error.cause instanceof Error ? error.cause.message : error.message}`,
      }
    }
    // The send may or may not have reached the cluster; watch for it.
    return watch()
  }
  return watch()
}

const isFinal = (status: string | null | undefined) =>
  status === 'confirmed' || status === 'finalized'

/**
 * Polls a sent transaction until it confirms, fails, or its blockhash
 * expires. A failure counts only once confirmed: one seen at `processed` may
 * be on a fork the cluster drops. A status that cannot be read is `unknown`,
 * never `failed`.
 */
export async function waitForConfirmation(
  rpc: TradeRpc,
  {
    signature,
    blockhash,
    lastValidBlockHeight,
    intervalMs,
  }: {
    signature: Signature
    blockhash: Blockhash
    lastValidBlockHeight: string
    intervalMs: number
  },
): Promise<SendResult> {
  const lastValid = BigInt(lastValidBlockHeight)
  try {
    for (;;) {
      const {
        value: [status],
      } = await rpc.getSignatureStatuses([signature]).send(rpcTimeout())
      if (status && isFinal(status.confirmationStatus))
        return status.err
          ? { status: 'failed', signature, error: json(status.err) }
          : { status: 'confirmed', signature }
      const height = await rpc
        .getBlockHeight({ commitment: 'confirmed' })
        .send(rpcTimeout())
      if (height > lastValid) {
        // It may have landed in the last valid blocks.
        const {
          value: [last],
        } = await rpc
          .getSignatureStatuses([signature], { searchTransactionHistory: true })
          .send(rpcTimeout())
        if (last && isFinal(last.confirmationStatus))
          return last.err
            ? { status: 'failed', signature, error: json(last.err) }
            : { status: 'confirmed', signature }
        if (last) return { status: 'unknown', signature }
        // A lagging RPC node can miss a landed transaction; only call it
        // expired once its blockhash is no longer valid either.
        const { value: valid } = await rpc
          .isBlockhashValid(blockhash, { commitment: 'confirmed' })
          .send(rpcTimeout())
        if (!valid) return { status: 'expired', signature }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  } catch {
    return { status: 'unknown', signature }
  }
}
