import { expect, test } from 'bun:test'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SolanaError,
  address,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signTransaction,
} from '@solana/kit'
import type { Address } from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getTokenEncoder,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  TokenInstruction,
  AccountState,
} from '@solana-program/token'
import {
  TransferError,
  prepareUsdcTransfer,
  sendUsdcTransfer,
} from './usdc-transfer'
import type { UsdcRpc } from './usdc-transfer'

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const OWNER = address('F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3')
const TO = address('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N')
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

/** A token account holding `amount`, as the RPC returns it. */
function tokenAccount(owner: Address, amount: bigint) {
  const data = getTokenEncoder().encode({
    mint: MINT,
    owner,
    amount,
    delegate: null,
    state: AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
  })
  return {
    data: [getBase64Decoder().decode(data), 'base64'] as const,
    executable: false,
    lamports: 2_039_280n,
    owner: TOKEN_PROGRAM_ADDRESS,
    rentEpoch: 0n,
    space: BigInt(data.length),
  }
}

/** An RPC that answers from memory; `calls` records what was asked. */
function fakeRpc(
  answers: Partial<Record<string, (...args: unknown[]) => unknown>>,
) {
  const calls: Array<[string, unknown[]]> = []
  const rpc = new Proxy(
    {},
    {
      get:
        (_, method: string) =>
        (...args: unknown[]) => ({
          send: async () => {
            calls.push([method, args])
            const answer = answers[method]
            if (!answer) throw new Error(`unexpected RPC call ${method}`)
            return answer(...args)
          },
        }),
    },
  ) as UsdcRpc
  return { rpc, calls }
}

const sourceAccount = () =>
  findAssociatedTokenPda({
    owner: OWNER,
    mint: MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  }).then(([account]) => account)

test('prepares a transfer the owner pays for, creating the recipient account', async () => {
  const { rpc } = fakeRpc({
    getAccountInfo: () => ({ value: tokenAccount(OWNER, 5_000_000n) }),
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
    }),
  })
  const wire = await prepareUsdcTransfer(rpc, {
    owner: OWNER,
    to: TO,
    amount: 1_500_000n,
    mint: MINT,
  })

  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire),
  )
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  )
  expect(message.lifetimeToken).toBe(BLOCKHASH)
  // Unsigned: the owner's signature slot is empty until the browser signs.
  expect(Object.values(transaction.signatures)).toEqual([null])

  const { feePayer, instructions } = decompileTransactionMessage(message)
  expect(feePayer.address).toBe(OWNER)
  expect(Array.from(instructions, (i) => i.programAddress)).toEqual([
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
  ])

  const transfer = instructions[1]
  if (!transfer?.accounts || !transfer.data) throw new Error('no transfer')
  expect(identifyTokenInstruction(transfer.data)).toBe(
    TokenInstruction.TransferChecked,
  )
  const parsed = parseTransferCheckedInstruction({
    programAddress: TOKEN_PROGRAM_ADDRESS,
    accounts: transfer.accounts,
    data: transfer.data,
  })
  expect(parsed.data).toEqual({
    discriminator: 12,
    amount: 1_500_000n,
    decimals: 6,
  })
  expect(parsed.accounts.source.address).toBe(await sourceAccount())
  expect(parsed.accounts.authority.address).toBe(OWNER)
  expect(parsed.accounts.mint.address).toBe(MINT)
})

test('refuses what cannot be withdrawn before touching the chain', async () => {
  const { rpc: noChain } = fakeRpc({})
  const request = { owner: OWNER, to: TO, amount: 1n, mint: MINT }
  await expect(
    prepareUsdcTransfer(noChain, { ...request, amount: 0n }),
  ).rejects.toThrow('Enter an amount')
  await expect(
    prepareUsdcTransfer(noChain, { ...request, to: OWNER }),
  ).rejects.toThrow('other than this wallet')

  const { rpc: empty } = fakeRpc({ getAccountInfo: () => ({ value: null }) })
  await expect(prepareUsdcTransfer(empty, request)).rejects.toThrow(
    'Not enough USDC',
  )
  const { rpc: short } = fakeRpc({
    getAccountInfo: () => ({ value: tokenAccount(OWNER, 999_999n) }),
  })
  await expect(
    prepareUsdcTransfer(short, { ...request, amount: 1_000_000n }),
  ).rejects.toThrow(TransferError)
})

/** A signed transfer, as the browser would return it. */
async function signedTransfer() {
  const signer = await generateKeyPairSigner()
  const { rpc } = fakeRpc({
    getAccountInfo: () => ({
      value: tokenAccount(signer.address, 5_000_000n),
    }),
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
    }),
  })
  const wire = await prepareUsdcTransfer(rpc, {
    owner: signer.address,
    to: TO,
    amount: 1n,
    mint: MINT,
  })
  const signed = await signTransaction(
    [signer.keyPair],
    getTransactionDecoder().decode(getBase64Encoder().encode(wire)),
  )
  const signature = signed.signatures[signer.address]
  if (!signature) throw new Error('unsigned')
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getBase58Decoder().decode(signature),
  }
}

test('sends a signed transfer and waits for the cluster to confirm it', async () => {
  const { wire, signature } = await signedTransfer()
  let polls = 0
  const { rpc, calls } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => ({
      value: [
        ++polls < 2 ? null : { confirmationStatus: 'confirmed', err: null },
      ],
    }),
    isBlockhashValid: () => ({ value: true }),
  })
  expect(await sendUsdcTransfer(rpc, wire, { intervalMs: 0 })).toEqual({
    signature,
  })
  expect(calls[0]).toEqual([
    'sendTransaction',
    [wire, { encoding: 'base64', preflightCommitment: 'confirmed' }],
  ])
  expect(calls[1]?.[1]).toEqual([[signature]])
})

const PREFLIGHT =
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE

/** The cluster's refusal to send; the simulation result is never read. */
function preflightFailure(cause: SolanaError) {
  const context = { cause } as unknown as ConstructorParameters<
    typeof SolanaError<typeof PREFLIGHT>
  >[1]
  return new SolanaError(PREFLIGHT, context)
}

test('a transfer that fails, expires or cannot be sent is reported', async () => {
  const { wire } = await signedTransfer()

  const { rpc: failed } = fakeRpc({
    sendTransaction: () => 'sig',
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'processed', err: { Custom: 1 } }],
    }),
  })
  await expect(sendUsdcTransfer(failed, wire)).rejects.toThrow(
    'failed on chain',
  )

  const { rpc: expired } = fakeRpc({
    sendTransaction: () => 'sig',
    getSignatureStatuses: () => ({ value: [null] }),
    isBlockhashValid: () => ({ value: false }),
  })
  await expect(sendUsdcTransfer(expired, wire)).rejects.toThrow('expired')

  const { rpc: noSol } = fakeRpc({
    sendTransaction: () => {
      throw preflightFailure(
        new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND),
      )
    },
  })
  await expect(sendUsdcTransfer(noSol, wire)).rejects.toThrow('needs SOL')

  const { rpc: down } = fakeRpc({
    sendTransaction: () => {
      throw new Error('https://rpc.example/?api-key=secret')
    },
  })
  await expect(sendUsdcTransfer(down, wire)).rejects.toThrow('api-key')

  const { rpc: unused } = fakeRpc({})
  await expect(sendUsdcTransfer(unused, 'not a transaction')).rejects.toThrow(
    'could not be read',
  )
})
