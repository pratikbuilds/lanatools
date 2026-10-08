import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  ComputeBudgetInstruction,
  getSetComputeUnitLimitInstructionDataDecoder,
  getSetComputeUnitPriceInstructionDataDecoder,
  identifyComputeBudgetInstruction,
} from '@solana-program/compute-budget'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  SolanaError,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
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

async function signedTransaction() {
  const signer = await generateKeyPairSigner()
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(signer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
          message,
        ),
      (message) => appendTransactionMessageInstructions([], message),
    ),
  )
  return {
    sent: {
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

test('a transaction that lands with an error is failed', async () => {
  const { sent, signature } = await signedTransaction()
  const { rpc } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () =>
      status('processed', { InstructionError: [0, { Custom: 6001 }] }),
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'failed',
    signature,
    error: '{"InstructionError":[0,{"Custom":6001}]}',
  })
})

test('a preflight refusal is failed, since nothing was broadcast', async () => {
  const { sent, signature } = await signedTransaction()
  const cause = new SolanaError(
    SOLANA_ERROR__TRANSACTION_ERROR__INSUFFICIENT_FUNDS_FOR_FEE,
  )
  const { rpc } = fakeRpc({
    sendTransaction: () => {
      throw new SolanaError(
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
    },
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'failed',
    signature,
    error: `The RPC refused the transaction in simulation: ${cause.message}`,
  })
})

test('a send that may have reached the cluster is unknown, never resent', async () => {
  const { sent, signature } = await signedTransaction()
  const { rpc, calls } = fakeRpc({
    sendTransaction: () => {
      throw new Error('socket hang up')
    },
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'unknown',
    signature,
  })
  expect(calls).toHaveLength(1)

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
  })
  expect(await sendSignedTransaction(rpc, sent, quick)).toEqual({
    status: 'expired',
    signature,
  })
  // The last look searches history: it may have landed in the final blocks.
  expect(calls.at(-1)).toEqual([
    'getSignatureStatuses',
    [[signature], { searchTransactionHistory: true }],
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

test('an unsigned transaction is refused before anything is sent', async () => {
  const { rpc, calls } = fakeRpc({
    getLatestBlockhash: latest,
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 1_000n, logs: [] },
    }),
  })
  const built = await buildTransaction(rpc, {
    feePayer: WALLET,
    instructions: [phoenixInstruction()],
    fees: FEES,
  })
  calls.length = 0
  await expect(sendSignedTransaction(rpc, built, quick)).rejects.toMatchObject({
    code: 'invalid_input',
    message: 'The transaction is not a fully signed Solana transaction',
  })
  expect(calls).toEqual([])
})
