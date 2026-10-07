import { expect, test } from 'bun:test'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SolanaError,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from '@solana/kit'
import type { Address, KeyPairSigner } from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
  findAssociatedTokenPda,
  getTokenEncoder,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
} from '@solana-program/token'
import {
  TransferError,
  prepareUsdcTransfer,
  readSignedWithdrawal,
  sendUsdcTransfer,
} from './usdc-transfer'
import type { UsdcRpc } from './usdc-transfer'

const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const OTHER_MINT = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const OWNER = address('F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3')
const TO = address('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N')
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const MEMO = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/** A token account holding `amount`, as the RPC returns it. */
function tokenAccount(owner: Address, amount: bigint, mint: Address = MINT) {
  const data = getTokenEncoder().encode({
    mint,
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

const ata = (owner: Address) =>
  findAssociatedTokenPda({
    owner,
    mint: MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  }).then(([account]) => account)

/** The owner's USDC account answers; the recipient does not exist. */
function accounts(owner: Address, usdc: bigint) {
  return async (requested: unknown) => ({
    value: requested === (await ata(owner)) ? tokenAccount(owner, usdc) : null,
  })
}

const lifetime = () => ({
  value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
})

function decodeWire(wire: string) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire),
  )
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  )
  return { transaction, compiled, ...decompileTransactionMessage(compiled) }
}

function parseTransfer(wire: string) {
  const { instructions } = decodeWire(wire)
  const transfer = instructions[instructions.length - 1]
  if (!transfer?.accounts || !transfer.data) throw new Error('no transfer')
  expect(identifyTokenInstruction(transfer.data)).toBe(
    TokenInstruction.TransferChecked,
  )
  return parseTransferCheckedInstruction({
    programAddress: TOKEN_PROGRAM_ADDRESS,
    accounts: transfer.accounts,
    data: transfer.data,
  })
}

test('prepares a transfer the owner pays for, creating the recipient account', async () => {
  const { rpc } = fakeRpc({
    getAccountInfo: accounts(OWNER, 5_000_000n),
    getLatestBlockhash: lifetime,
  })
  const wire = await prepareUsdcTransfer(rpc, {
    owner: OWNER,
    to: TO,
    amount: 1_500_000n,
    mint: MINT,
  })

  const { transaction, compiled, feePayer, instructions } = decodeWire(wire)
  expect(compiled.lifetimeToken).toBe(BLOCKHASH)
  expect(feePayer.address).toBe(OWNER)
  // Unsigned: the owner's signature slot is empty until the browser signs.
  expect(Object.values(transaction.signatures)).toEqual([null])
  expect(Array.from(instructions, (i) => i.programAddress)).toEqual([
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
  ])
  const parsed = parseTransfer(wire)
  expect(parsed.data).toEqual({
    discriminator: 12,
    amount: 1_500_000n,
    decimals: 6,
  })
  expect(parsed.accounts.source.address).toBe(await ata(OWNER))
  expect(parsed.accounts.destination.address).toBe(await ata(TO))
  expect(parsed.accounts.authority.address).toBe(OWNER)
  expect(parsed.accounts.mint.address).toBe(MINT)
})

test('a USDC token account as the destination is paid directly', async () => {
  const exchangeDeposit = await ata(TO)
  const { rpc } = fakeRpc({
    getAccountInfo: async (requested: unknown) => ({
      value:
        requested === (await ata(OWNER))
          ? tokenAccount(OWNER, 5_000_000n)
          : requested === exchangeDeposit
            ? tokenAccount(TO, 0n)
            : null,
    }),
    getLatestBlockhash: lifetime,
  })
  const wire = await prepareUsdcTransfer(rpc, {
    owner: OWNER,
    to: exchangeDeposit,
    amount: 1n,
    mint: MINT,
  })
  const { instructions } = decodeWire(wire)
  expect(instructions).toHaveLength(1)
  expect(parseTransfer(wire).accounts.destination.address).toBe(exchangeDeposit)
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
    getAccountInfo: accounts(OWNER, 999_999n),
  })
  await expect(
    prepareUsdcTransfer(short, { ...request, amount: 1_000_000n }),
  ).rejects.toThrow(TransferError)

  // The wallet's own token account is still the wallet.
  const { rpc: own } = fakeRpc({
    getAccountInfo: accounts(OWNER, 5_000_000n),
  })
  await expect(
    prepareUsdcTransfer(own, { ...request, to: await ata(OWNER) }),
  ).rejects.toThrow('other than this wallet')

  const { rpc: otherToken } = fakeRpc({
    getAccountInfo: async (requested: unknown) => ({
      value:
        requested === TO
          ? tokenAccount(TO, 0n, OTHER_MINT)
          : tokenAccount(OWNER, 5_000_000n),
    }),
  })
  await expect(prepareUsdcTransfer(otherToken, request)).rejects.toThrow(
    'another token',
  )
})

/** A withdrawal signed by its owner, as the browser would return it. */
async function signedWithdrawal(signer: KeyPairSigner) {
  const { rpc } = fakeRpc({
    getAccountInfo: accounts(signer.address, 5_000_000n),
    getLatestBlockhash: lifetime,
  })
  const wire = await prepareUsdcTransfer(rpc, {
    owner: signer.address,
    to: TO,
    amount: 1n,
    mint: MINT,
  })
  return sign(signer, wire)
}

async function sign(signer: KeyPairSigner, wire: string) {
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

test('only a withdrawal signed by its own wallet is read', async () => {
  const owner = await generateKeyPairSigner()
  const { wire, signature } = await signedWithdrawal(owner)
  const withdrawal = await readSignedWithdrawal(wire, MINT)
  expect(withdrawal.payer).toBe(owner.address)
  expect(withdrawal.signature).toBe(signature)
  expect(String(withdrawal.blockhash)).toBe(BLOCKHASH)

  await expect(readSignedWithdrawal('not a transaction', MINT)).rejects.toThrow(
    'could not be read',
  )
  // Prepared but never signed.
  const { rpc } = fakeRpc({
    getAccountInfo: accounts(owner.address, 5_000_000n),
    getLatestBlockhash: lifetime,
  })
  const unsigned = await prepareUsdcTransfer(rpc, {
    owner: owner.address,
    to: TO,
    amount: 1n,
    mint: MINT,
  })
  await expect(readSignedWithdrawal(unsigned, MINT)).rejects.toThrow(
    'not signed',
  )
  // The same transfer for another mint is not a USDC withdrawal.
  await expect(readSignedWithdrawal(wire, OTHER_MINT)).rejects.toThrow(
    'not a USDC withdrawal',
  )
  // A signed transaction that is not a withdrawal is refused as well.
  const memo = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(lifetime().value as never, m),
    (m) =>
      appendTransactionMessageInstruction(
        { programAddress: MEMO, data: new TextEncoder().encode('hi') },
        m,
      ),
  )
  const other = await sign(
    owner,
    getBase64EncodedWireTransaction(compileTransaction(memo)),
  )
  await expect(readSignedWithdrawal(other.wire, MINT)).rejects.toThrow(
    'not a USDC withdrawal',
  )
})

test('sends a signed transfer and waits for the cluster to confirm it', async () => {
  const owner = await generateKeyPairSigner()
  const { wire, signature } = await signedWithdrawal(owner)
  const withdrawal = await readSignedWithdrawal(wire, MINT)
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
  expect(await sendUsdcTransfer(rpc, withdrawal, { intervalMs: 0 })).toEqual({
    signature,
    confirmed: true,
  })
  expect(calls[0]).toEqual([
    'sendTransaction',
    [wire, { encoding: 'base64', preflightCommitment: 'confirmed' }],
  ])
  expect(calls[1]?.[1]).toEqual([[signature]])
})

test('a transfer that fails, expires or cannot be sent is reported', async () => {
  const owner = await generateKeyPairSigner()
  const { wire } = await signedWithdrawal(owner)
  const withdrawal = await readSignedWithdrawal(wire, MINT)

  const { rpc: failed } = fakeRpc({
    sendTransaction: () => 'sig',
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'processed', err: { Custom: 1 } }],
    }),
  })
  await expect(sendUsdcTransfer(failed, withdrawal)).rejects.toThrow(
    'failed on chain',
  )

  const { rpc: expired } = fakeRpc({
    sendTransaction: () => 'sig',
    getSignatureStatuses: () => ({ value: [null] }),
    isBlockhashValid: () => ({ value: false }),
  })
  await expect(sendUsdcTransfer(expired, withdrawal)).rejects.toThrow('expired')

  const { rpc: noSol } = fakeRpc({
    sendTransaction: () => {
      throw preflightFailure(
        new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND),
      )
    },
  })
  await expect(sendUsdcTransfer(noSol, withdrawal)).rejects.toThrow('needs SOL')

  const { rpc: down } = fakeRpc({
    sendTransaction: () => {
      throw new Error('https://rpc.example/?api-key=secret')
    },
  })
  await expect(sendUsdcTransfer(down, withdrawal)).rejects.toThrow('api-key')
})

test('a sent transfer whose status cannot be read is returned unconfirmed, never as failed', async () => {
  const owner = await generateKeyPairSigner()
  const { wire, signature } = await signedWithdrawal(owner)
  const withdrawal = await readSignedWithdrawal(wire, MINT)
  const { rpc } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => {
      throw new Error('timed out')
    },
  })
  expect(await sendUsdcTransfer(rpc, withdrawal)).toEqual({
    signature,
    confirmed: false,
  })
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
