import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  getSetComputeUnitLimitInstructionDataDecoder,
  getSetComputeUnitPriceInstructionDataDecoder,
  identifyComputeBudgetInstruction,
} from '@solana-program/compute-budget'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  SolanaError,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import { expect, test } from 'bun:test'
import { BLOCKHASH, WALLET, fakeRpc, phoenixInstruction } from './fixtures'
import {
  MAX_COMPUTE_UNITS,
  buildTransaction,
  sendSignedTransaction,
} from './transaction'

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }

const latest = () => ({
  value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
})

function readWire(wire: string) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire),
  )
  const message = decompileTransactionMessage(
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes),
  )
  const budget = message.instructions.filter(
    (instruction) =>
      instruction.programAddress === COMPUTE_BUDGET_PROGRAM_ADDRESS,
  )
  const limit = budget.find(
    (instruction) =>
      instruction.data &&
      identifyComputeBudgetInstruction(instruction.data) ===
        ComputeBudgetInstruction.SetComputeUnitLimit,
  )
  const price = budget.find(
    (instruction) =>
      instruction.data &&
      identifyComputeBudgetInstruction(instruction.data) ===
        ComputeBudgetInstruction.SetComputeUnitPrice,
  )
  return {
    feePayer: message.feePayer.address,
    signatures: Object.values(transaction.signatures),
    units: limit?.data
      ? getSetComputeUnitLimitInstructionDataDecoder().decode(limit.data).units
      : undefined,
    microLamports: price?.data
      ? getSetComputeUnitPriceInstructionDataDecoder().decode(price.data)
          .microLamports
      : undefined,
    others: message.instructions.length - budget.length,
  }
}

test('a transaction is measured by simulation and compiled with the margin', async () => {
  const { rpc, calls } = fakeRpc({
    getLatestBlockhash: latest,
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 507_239n, logs: ['Program log: ok'] },
    }),
  })
  const built = await buildTransaction(rpc, {
    feePayer: WALLET,
    instructions: [phoenixInstruction()],
    fees: FEES,
  })

  const [probe, config] =
    calls.find(([method]) => method === 'simulateTransaction')?.[1] ?? []
  expect(config).toEqual({
    encoding: 'base64',
    commitment: 'confirmed',
    sigVerify: false,
    replaceRecentBlockhash: false,
  })
  expect(readWire(String(probe)).units).toBe(MAX_COMPUTE_UNITS)

  // 507,239 × 1.2 = 608,686.8, rounded up.
  const wire = readWire(built.transaction)
  expect(wire).toEqual({
    feePayer: WALLET,
    signatures: [null],
    units: 608_687,
    microLamports: undefined,
    others: 1,
  })
  expect(built.lastValidBlockHeight).toBe('500')
  expect(built.simulation).toEqual({
    ok: true,
    computeUnits: 507_239,
    logs: ['Program log: ok'],
  })
})

test('a priority fee adds a compute price instruction', async () => {
  const { rpc } = fakeRpc({
    getLatestBlockhash: latest,
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 1_200_000n, logs: [] },
    }),
  })
  const built = await buildTransaction(rpc, {
    feePayer: WALLET,
    instructions: [phoenixInstruction()],
    fees: { computeUnitMargin: 0.5, microLamportsPerComputeUnit: 25_000n },
  })
  // 1.8M would exceed the maximum, so it stops there.
  expect(readWire(built.transaction)).toMatchObject({
    units: MAX_COMPUTE_UNITS,
    microLamports: 25_000n,
  })
})

test("a failed simulation returns Phoenix's reason with the transaction", async () => {
  const { rpc } = fakeRpc({
    getLatestBlockhash: latest,
    simulateTransaction: () => ({
      value: {
        err: { InstructionError: [1n, 'InvalidInstructionData'] },
        unitsConsumed: 382_415n,
        logs: [
          'Program log: Failed to perform MatchingEngine::place_order',
          'Program log: IOC order does not meet minimum requirements.',
          'Program EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih failed: invalid instruction data',
        ],
      },
    }),
  })
  const built = await buildTransaction(rpc, {
    feePayer: WALLET,
    instructions: [phoenixInstruction()],
    fees: FEES,
  })
  expect(built.simulation).toMatchObject({
    ok: false,
    computeUnits: 382_415,
    error:
      '{"InstructionError":["1","InvalidInstructionData"]}: IOC order does not meet minimum requirements.',
  })
  expect(readWire(built.transaction).units).toBe(MAX_COMPUTE_UNITS)
})

test('a simulation that reports no compute use is an upstream error', async () => {
  const { rpc } = fakeRpc({
    getLatestBlockhash: latest,
    simulateTransaction: () => ({ value: { err: null, logs: [] } }),
  })
  await expect(
    buildTransaction(rpc, {
      feePayer: WALLET,
      instructions: [phoenixInstruction()],
      fees: FEES,
    }),
  ).rejects.toMatchObject({ code: 'upstream_error' })
})

test('negative fee settings are refused before any RPC call', async () => {
  const { rpc, calls } = fakeRpc({})
  await expect(
    buildTransaction(rpc, {
      feePayer: WALLET,
      instructions: [],
      fees: { computeUnitMargin: -0.1, microLamportsPerComputeUnit: 0n },
    }),
  ).rejects.toThrow('must not be negative')
  expect(calls).toEqual([])
})

/** A transaction as a tool returns it (unsigned), and as the wallet signs it. */
async function signedTransaction() {
  const signer = await generateKeyPairSigner()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(signer, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
        draft,
      ),
    (draft) => appendTransactionMessageInstructions([], draft),
  )
  const signed = await signTransactionMessageWithSigners(message)
  return {
    sent: {
      prepared: getBase64EncodedWireTransaction(compileTransaction(message)),
      transaction: getBase64EncodedWireTransaction(signed),
      lastValidBlockHeight: '500',
    },
    signature: getSignatureFromTransaction(signed),
  }
}

const status = (confirmationStatus: string, err: unknown = null) => ({
  value: [{ confirmationStatus, err }],
})
const noStatus = () => ({ value: [null] })
const quick = { intervalMs: 0 }

test('a sent transaction is polled until it confirms', async () => {
  const { sent, signature } = await signedTransaction()
  const answers = [noStatus(), status('processed'), status('confirmed')]
  const { rpc, calls } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => answers.shift(),
    getBlockHeight: () => 400n,
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'confirmed',
    signature,
  })
  expect(calls.filter(([method]) => method === 'sendTransaction')).toHaveLength(
    1,
  )
})

test('a failure counts only once it is confirmed', async () => {
  const { sent, signature } = await signedTransaction()
  const error = { InstructionError: [0, { Custom: 6001 }] }
  // Seen failing at processed (perhaps on a fork), then landing fine.
  const answers = [status('processed', error), status('confirmed')]
  const { rpc } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => answers.shift(),
    getBlockHeight: () => 400n,
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'confirmed',
    signature,
  })

  const { rpc: failed } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => status('confirmed', error),
  })
  expect(await sendSignedTransaction(failed, sent, quick)).toEqual({
    status: 'failed',
    signature,
    error: '{"InstructionError":[0,{"Custom":6001}]}',
  })
})

const preflight = (cause: SolanaError) =>
  new SolanaError(
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    {
      cause,
      accounts: null,
      fee: null,
      innerInstructions: null,
      loadedAccountsDataSize: null,
      loadedAddresses: null,
      logs: null,
      postBalances: null,
      postTokenBalances: null,
      preBalances: null,
      preTokenBalances: null,
      replacementBlockhash: null,
      returnData: null,
      unitsConsumed: 0n,
    },
  )

test('a preflight refusal is failed, since nothing was broadcast', async () => {
  const { sent, signature } = await signedTransaction()
  const cause = new SolanaError(
    SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  )
  const { rpc } = fakeRpc({
    sendTransaction: () => {
      throw preflight(cause)
    },
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'failed',
    signature,
    error: `The RPC refused the transaction in simulation: ${cause.message}`,
  })
})

test('resending bytes that already landed is watched, not failed', async () => {
  const { sent, signature } = await signedTransaction()
  const { rpc } = fakeRpc({
    sendTransaction: () => {
      throw preflight(
        new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ALREADY_PROCESSED),
      )
    },
    getSignatureStatuses: () => status('finalized'),
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'confirmed',
    signature,
  })
})

test('a send that may have reached the cluster is watched, never resent', async () => {
  const { sent, signature } = await signedTransaction()
  const { rpc, calls } = fakeRpc({
    sendTransaction: () => {
      throw new Error('socket hang up')
    },
    getSignatureStatuses: () => status('confirmed'),
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'confirmed',
    signature,
  })
  expect(calls.filter(([method]) => method === 'sendTransaction')).toHaveLength(
    1,
  )

  const { rpc: unreadable } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => {
      throw new Error('timed out')
    },
  })
  expect(await sendSignedTransaction(unreadable, sent, quick)).toEqual({
    status: 'unknown',
    signature,
  })
})

test('past its last valid block height, a missing transaction has expired', async () => {
  const { sent, signature } = await signedTransaction()
  const { rpc, calls } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: noStatus,
    getBlockHeight: () => 501n,
    isBlockhashValid: () => ({ value: false }),
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'expired',
    signature,
  })
  // It looks through history, then asks whether the blockhash still lives.
  expect(calls.slice(-2)).toEqual([
    ['getSignatureStatuses', [[signature], { searchTransactionHistory: true }]],
    ['isBlockhashValid', [BLOCKHASH, { commitment: 'confirmed' }]],
  ])

  const late = [noStatus(), status('confirmed')]
  const { rpc: landed } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => late.shift(),
    getBlockHeight: () => 501n,
  })
  expect(await sendSignedTransaction(landed, sent, quick)).toEqual({
    status: 'confirmed',
    signature,
  })

  const pending = [noStatus(), status('processed')]
  const { rpc: processed } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => pending.shift(),
    getBlockHeight: () => 501n,
  })
  expect(await sendSignedTransaction(processed, sent, quick)).toEqual({
    status: 'unknown',
    signature,
  })
})

test('a lagging RPC node does not turn a live transaction into expired', async () => {
  const { sent, signature } = await signedTransaction()
  // Height is past, the node has no status yet, but the blockhash still
  // lives: keep watching; the next read finds it confirmed.
  const answers = [noStatus(), noStatus(), status('confirmed')]
  const { rpc } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => answers.shift(),
    getBlockHeight: () => 501n,
    isBlockhashValid: () => ({ value: true }),
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'confirmed',
    signature,
  })
})

test('only the prepared transaction, validly signed, is sent', async () => {
  const { sent } = await signedTransaction()
  const other = await signedTransaction()
  const { rpc, calls } = fakeRpc({})
  await expect(
    sendSignedTransaction(
      rpc,
      { ...sent, transaction: other.sent.transaction },
      quick,
    ),
  ).rejects.toMatchObject({
    code: 'invalid_input',
    message:
      'The signed transaction is not the one that was prepared; nothing was sent',
  })
  // The prepared bytes themselves carry no signature.
  await expect(
    sendSignedTransaction(rpc, { ...sent, transaction: sent.prepared }, quick),
  ).rejects.toMatchObject({
    code: 'invalid_input',
    message: 'The transaction is not signed by its fee payer; nothing was sent',
  })
  // A signature over other bytes does not verify.
  const forged = getBase64Encoder().encode(sent.transaction).slice()
  forged[1] = (forged[1] ?? 0) ^ 1
  await expect(
    sendSignedTransaction(
      rpc,
      { ...sent, transaction: getBase64Decoder().decode(forged) },
      quick,
    ),
  ).rejects.toMatchObject({
    message: 'The transaction is not signed by its fee payer; nothing was sent',
  })
  expect(calls).toEqual([])
})
