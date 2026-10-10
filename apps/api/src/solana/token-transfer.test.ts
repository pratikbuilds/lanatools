import { expect, test } from 'bun:test'
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND,
  SolanaError,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createNoopSigner,
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
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  findAssociatedTokenPda,
  getTokenEncoder,
  getMintEncoder,
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
} from '@solana-program/token'
import {
  TransferError,
  TOKEN_2022_PROGRAM,
  prepareTokenTransfer,
  readSignedWithdrawal,
  sendWithdrawal,
} from './token-transfer'
import type { WithdrawalRpc } from './token-transfer'

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
  {
    decimals = 6,
    program: tokenProgram = TOKEN_PROGRAM_ADDRESS,
  }: { decimals?: number; program?: Address } = {},
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
            if (method === 'simulateTransaction' && !answers[method])
              return { value: { err: null } }
            const answer = answers[method]
            if (!answer) throw new Error(`unexpected RPC call ${method}`)
            if (method === 'getAccountInfo' && args[0] === MINT) {
              const data = getMintEncoder().encode({
                mintAuthority: null,
                supply: 1_000_000_000n,
                decimals,
                isInitialized: true,
                freezeAuthority: null,
              })
              return {
                value: {
                  ...tokenAccount(OWNER, 0n),
                  data: [getBase64Decoder().decode(data), 'base64'],
                  owner: tokenProgram,
                },
              }
            }
            return answer(...args)
          },
        }),
    },
  ) as WithdrawalRpc
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
  const wire = await prepareTokenTransfer(rpc, {
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
  const wire = await prepareTokenTransfer(rpc, {
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
    prepareTokenTransfer(noChain, { ...request, amount: 0n }),
  ).rejects.toThrow('Enter a valid amount')
  await expect(
    prepareTokenTransfer(noChain, { ...request, to: OWNER }),
  ).rejects.toThrow('other than this wallet')

  const { rpc: empty } = fakeRpc({ getAccountInfo: () => ({ value: null }) })
  await expect(prepareTokenTransfer(empty, request)).rejects.toThrow(
    'does not belong',
  )
  const { rpc: short } = fakeRpc({
    getAccountInfo: accounts(OWNER, 999_999n),
  })
  await expect(
    prepareTokenTransfer(short, { ...request, amount: 1_000_000n }),
  ).rejects.toThrow(TransferError)

  // The wallet's own token account is still the wallet.
  const { rpc: own } = fakeRpc({
    getAccountInfo: accounts(OWNER, 5_000_000n),
  })
  await expect(
    prepareTokenTransfer(own, { ...request, to: await ata(OWNER) }),
  ).rejects.toThrow('other than this wallet')

  const { rpc: otherToken } = fakeRpc({
    getAccountInfo: async (requested: unknown) => ({
      value:
        requested === TO
          ? tokenAccount(TO, 0n, OTHER_MINT)
          : tokenAccount(OWNER, 5_000_000n),
    }),
  })
  await expect(prepareTokenTransfer(otherToken, request)).rejects.toThrow(
    'another token',
  )
})

/** A withdrawal signed by its owner, as the browser would return it. */
async function signedWithdrawal(signer: KeyPairSigner) {
  const { rpc } = fakeRpc({
    getAccountInfo: accounts(signer.address, 5_000_000n),
    getLatestBlockhash: lifetime,
  })
  const wire = await prepareTokenTransfer(rpc, {
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
  const withdrawal = await readSignedWithdrawal(wire)
  expect(withdrawal.payer).toBe(owner.address)
  expect(withdrawal.signature).toBe(signature)
  expect(String(withdrawal.blockhash)).toBe(BLOCKHASH)

  await expect(readSignedWithdrawal('not a transaction')).rejects.toThrow(
    'could not be read',
  )
  // Prepared but never signed.
  const { rpc } = fakeRpc({
    getAccountInfo: accounts(owner.address, 5_000_000n),
    getLatestBlockhash: lifetime,
  })
  const unsigned = await prepareTokenTransfer(rpc, {
    owner: owner.address,
    to: TO,
    amount: 1n,
    mint: MINT,
  })
  await expect(readSignedWithdrawal(unsigned)).rejects.toThrow('not signed')
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
  await expect(readSignedWithdrawal(other.wire)).rejects.toThrow(
    'not a token withdrawal',
  )
})

test('sends a signed transfer and waits for the cluster to confirm it', async () => {
  const owner = await generateKeyPairSigner()
  const { wire, signature } = await signedWithdrawal(owner)
  const withdrawal = await readSignedWithdrawal(wire)
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
  expect(await sendWithdrawal(rpc, withdrawal, { intervalMs: 0 })).toEqual({
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
  const withdrawal = await readSignedWithdrawal(wire)

  const { rpc: failed } = fakeRpc({
    sendTransaction: () => 'sig',
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'processed', err: { Custom: 1 } }],
    }),
  })
  await expect(sendWithdrawal(failed, withdrawal)).rejects.toThrow(
    'failed on chain',
  )

  const { rpc: expired } = fakeRpc({
    sendTransaction: () => 'sig',
    getSignatureStatuses: () => ({ value: [null] }),
    isBlockhashValid: () => ({ value: false }),
  })
  await expect(sendWithdrawal(expired, withdrawal)).rejects.toThrow('expired')

  const { rpc: noSol } = fakeRpc({
    sendTransaction: () => {
      throw preflightFailure(
        new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__ACCOUNT_NOT_FOUND),
      )
    },
  })
  await expect(sendWithdrawal(noSol, withdrawal)).rejects.toThrow('needs SOL')

  const { rpc: down } = fakeRpc({
    sendTransaction: () => {
      throw new Error('https://rpc.example/?api-key=secret')
    },
  })
  expect(await sendWithdrawal(down, withdrawal)).toEqual({
    signature: withdrawal.signature,
    confirmed: false,
  })
})

test('a sent transfer whose status cannot be read is returned unconfirmed, never as failed', async () => {
  const owner = await generateKeyPairSigner()
  const { wire, signature } = await signedWithdrawal(owner)
  const withdrawal = await readSignedWithdrawal(wire)
  const { rpc } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => {
      throw new Error('timed out')
    },
  })
  expect(await sendWithdrawal(rpc, withdrawal)).toEqual({
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

test('withdraws a Token-2022 mint at its on-chain precision from a non-associated account', async () => {
  const owner = await generateKeyPairSigner()
  const source = OWNER
  const { rpc } = fakeRpc(
    {
      getAccountInfo: (requested) => ({
        value:
          requested === source
            ? {
                ...tokenAccount(owner.address, 100n),
                owner: TOKEN_2022_PROGRAM,
              }
            : null,
      }),
      getLatestBlockhash: lifetime,
    },
    { decimals: 2, program: TOKEN_2022_PROGRAM },
  )
  const wire = await prepareTokenTransfer(rpc, {
    owner: owner.address,
    to: TO,
    amount: 25n,
    mint: MINT,
    source,
  })
  const { instructions } = decodeWire(wire)
  expect(instructions[1]?.programAddress).toBe(TOKEN_2022_PROGRAM)
  const transfer = parseTransferCheckedInstruction(
    instructions[1] as Parameters<typeof parseTransferCheckedInstruction>[0],
  )
  expect(transfer.data.decimals).toBe(2)
  expect(transfer.accounts.source.address).toBe(source)
  const expected = await findAssociatedTokenPda({
    owner: TO,
    mint: MINT,
    tokenProgram: TOKEN_2022_PROGRAM,
  })
  expect(transfer.accounts.destination.address).toBe(expected[0])
  const signed = await sign(owner, wire)
  expect((await readSignedWithdrawal(signed.wire)).payer).toBe(owner.address)
})

test('cannot spend another wallet account, the wrong mint or frozen tokens', async () => {
  for (const data of [
    tokenAccount(TO, 100n),
    tokenAccount(OWNER, 100n, OTHER_MINT),
    {
      ...tokenAccount(OWNER, 100n),
      data: [
        getBase64Decoder().decode(
          getTokenEncoder().encode({
            mint: MINT,
            owner: OWNER,
            amount: 100n,
            delegate: null,
            state: AccountState.Frozen,
            isNative: null,
            delegatedAmount: 0n,
            closeAuthority: null,
          }),
        ),
        'base64',
      ],
    },
  ]) {
    const { rpc } = fakeRpc({
      getAccountInfo: (requested) => ({
        value: requested === OWNER ? data : null,
      }),
    })
    await expect(
      prepareTokenTransfer(rpc, {
        owner: OWNER,
        to: TO,
        source: OWNER,
        mint: MINT,
        amount: 1n,
      }),
    ).rejects.toThrow(TransferError)
  }
})

test('SOL withdrawals reserve the actual fee and are checked after signing', async () => {
  const owner = await generateKeyPairSigner()
  const { rpc } = fakeRpc({
    getAccountInfo: () => ({ value: null }),
    getLatestBlockhash: lifetime,
    getBalance: () => ({ value: 100_000n }),
    getFeeForMessage: () => ({ value: 5_000n }),
  })
  const wire = await prepareTokenTransfer(rpc, {
    owner: owner.address,
    to: TO,
    mint: 'native',
    amount: 95_000n,
  })
  const signed = await sign(owner, wire)
  expect((await readSignedWithdrawal(signed.wire)).payer).toBe(owner.address)
  await expect(
    prepareTokenTransfer(rpc, {
      owner: owner.address,
      to: TO,
      mint: 'native',
      amount: 100_000n,
    }),
  ).rejects.toThrow('network fee')
})

test('rejects a signed account creation unrelated to the withdrawal', async () => {
  const owner = await generateKeyPairSigner()
  const create = getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(owner.address),
    ata: await ata(TO),
    owner: TO,
    mint: MINT,
  })
  const transfer = getTransferCheckedInstruction({
    source: await ata(owner.address),
    mint: MINT,
    destination: OTHER_MINT,
    authority: owner.address,
    amount: 1n,
    decimals: 6,
  })
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(owner.address, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(lifetime().value as never, m),
    (m) => appendTransactionMessageInstruction(create, m),
    (m) => appendTransactionMessageInstruction(transfer, m),
  )
  const signed = await sign(
    owner,
    getBase64EncodedWireTransaction(compileTransaction(message)),
  )
  await expect(readSignedWithdrawal(signed.wire)).rejects.toThrow(
    'not a token withdrawal',
  )
})

test('a restricted token is refused before the user signs or pays a fee', async () => {
  const { rpc } = fakeRpc({
    getAccountInfo: accounts(OWNER, 100n),
    getLatestBlockhash: lifetime,
    simulateTransaction: () => ({
      value: { err: { InstructionError: [0, { Custom: 1 }] } },
    }),
  })
  await expect(
    prepareTokenTransfer(rpc, { owner: OWNER, to: TO, mint: MINT, amount: 1n }),
  ).rejects.toThrow('token transfer restrictions')
})
