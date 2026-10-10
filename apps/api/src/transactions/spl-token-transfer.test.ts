import { expect, test } from 'bun:test'
import {
  address,
  blockhash,
  decompileTransactionMessage,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import type { Address, ReadonlyUint8Array } from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  AccountState,
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  parseTransferCheckedInstruction,
} from '@solana-program/token'
import { SOLANA_NETWORKS } from '@lanatools/contracts/networks'
import { TransferError } from '../solana/token-transfer'
import type { BuilderContext } from './adapter'
import {
  TOKEN_TRANSFER_PROGRAMS,
  tokenBaseUnits,
  tokenTransfer,
} from './spl-token-transfer'
import type { TransactionRpc } from './submission'
import { transactionTools } from './tools'

const USDC = address(SOLANA_NETWORKS.devnet.usdcMint)
const WSOL = address('So11111111111111111111111111111111111111112')
const OWNER = address('F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3')
const TO = address('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N')
const MEMO = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const BLOCKHASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

/** An account as the RPC returns it: base64 data owned by `owner`. */
function account(data: ReadonlyUint8Array, owner: Address) {
  return {
    data: [getBase64Decoder().decode(data), 'base64'] as const,
    executable: false,
    lamports: 2_039_280n,
    owner,
    rentEpoch: 0n,
    space: BigInt(data.length),
  }
}

function mint(decimals: number) {
  return account(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }),
    TOKEN_PROGRAM_ADDRESS,
  )
}

function tokenAccount(owner: Address, amount: bigint) {
  return account(
    getTokenEncoder().encode({
      mint: USDC,
      owner,
      amount,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
    TOKEN_PROGRAM_ADDRESS,
  )
}

const ata = (owner: Address) =>
  findAssociatedTokenPda({
    owner,
    mint: USDC,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  }).then(([pda]) => pda)

/** A builder context whose RPC answers account reads from `accounts` only. */
function context(accounts: Map<string, unknown>): BuilderContext {
  const refuse = (method: string) => async () => {
    throw new Error(`unexpected RPC call ${method}`)
  }
  const reads = new Proxy(
    {},
    {
      get: (_, method: string) => (requested: unknown) => ({
        send: async () => {
          if (method !== 'getAccountInfo')
            throw new Error(`unexpected RPC call ${method}`)
          return { value: accounts.get(String(requested)) ?? null }
        },
      }),
    },
  ) as TransactionRpc['accounts']
  return {
    requestId: 'request-1',
    network: 'devnet',
    rpc: {
      accounts: reads,
      genesisHash: refuse('genesisHash'),
      latestBlockhash: async () => ({
        blockhash: blockhash(BLOCKHASH),
        lastValidBlockHeight: 500n,
      }),
      blockHeight: refuse('blockHeight'),
      send: refuse('send'),
      status: refuse('status'),
    },
  }
}

/** The owner holds `held` USDC; the recipient has whatever `extra` says. */
async function chain(held: bigint, extra: Record<string, unknown> = {}) {
  return new Map<string, unknown>([
    [USDC, mint(6)],
    [await ata(OWNER), tokenAccount(OWNER, held)],
    ...Object.entries(extra),
  ])
}

function decode(wire: string) {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire),
  )
  const compiled = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes,
  )
  return { transaction, compiled, ...decompileTransactionMessage(compiled) }
}

const intent = { recipient: TO, mint: USDC, amount: '1.5' }

test('converts decimal token units to base units exactly', () => {
  expect(tokenBaseUnits('1.5', 6)).toBe(1_500_000n)
  expect(tokenBaseUnits('1.500000000', 6)).toBe(1_500_000n)
  expect(tokenBaseUnits('0.000001', 6)).toBe(1n)
  expect(tokenBaseUnits('7', 0)).toBe(7n)
  expect(() => tokenBaseUnits('0.0000001', 6)).toThrow(TransferError)
  expect(() => tokenBaseUnits('1.5', 0)).toThrow('0 decimals')
  expect(() => tokenBaseUnits('18446744073709551616', 0)).toThrow('too large')
})

test('names USDC and shows other tokens by mint', () => {
  expect(tokenTransfer.describe(intent)).toEqual({
    title: 'Send USDC',
    description:
      'Send tokens from your connected wallet to the recipient below. Network fees are paid in SOL.',
    actionLabel: 'Send USDC',
    fields: [
      { label: 'Amount', value: '1.5 USDC' },
      { label: 'Token', value: USDC },
      { label: 'Recipient', value: TO },
    ],
  })
  const other = tokenTransfer.describe({ ...intent, mint: WSOL })
  expect(other.title).toBe('Send tokens')
  expect(other.fields[0]).toEqual({ label: 'Amount', value: '1.5 So11…1112' })
})

test('rejects malformed intents before any lookup', () => {
  const schema = tokenTransfer.arguments
  expect(schema.safeParse(intent).success).toBe(true)
  for (const bad of [
    { ...intent, amount: '0' },
    { ...intent, amount: '1,5' },
    { ...intent, amount: '.5' },
    { ...intent, amount: '-1' },
    { ...intent, amount: '1e6' },
    { ...intent, mint: 'not-a-mint' },
    { ...intent, recipient: 'not-an-address' },
    { ...intent, network: 'devnet' },
  ])
    expect(schema.safeParse(bad).success).toBe(false)
})

test('builds a checked transfer the signer pays for, creating the recipient account', async () => {
  const candidate = await tokenTransfer.build(
    intent,
    OWNER,
    context(await chain(5_000_000n)),
  )
  expect(candidate).toMatchObject({
    account: OWNER,
    network: 'devnet',
    blockhash: BLOCKHASH,
    lastValidBlockHeight: '500',
    review: tokenTransfer.describe(intent),
  })
  const { transaction, compiled, feePayer, instructions } = decode(
    candidate.transaction,
  )
  expect(compiled.lifetimeToken).toBe(BLOCKHASH)
  expect(feePayer.address).toBe(OWNER)
  expect(Object.values(transaction.signatures)).toEqual([null])
  expect(Array.from(instructions, (each) => each.programAddress)).toEqual([
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    TOKEN_PROGRAM_ADDRESS,
    MEMO,
  ])
  const transfer = instructions[1]!
  const parsed = parseTransferCheckedInstruction({
    programAddress: TOKEN_PROGRAM_ADDRESS,
    accounts: transfer.accounts!,
    data: transfer.data!,
  })
  expect(parsed.data).toMatchObject({ amount: 1_500_000n, decimals: 6 })
  expect(parsed.accounts.source.address).toBe(await ata(OWNER))
  expect(parsed.accounts.destination.address).toBe(await ata(TO))
  expect(parsed.accounts.authority.address).toBe(OWNER)
  expect(new TextDecoder().decode(instructions[2]!.data)).toBe(
    'lanatools:request-1',
  )
})

test('pays an existing token account directly', async () => {
  const deposit = await ata(TO)
  const candidate = await tokenTransfer.build(
    { ...intent, recipient: deposit },
    OWNER,
    context(await chain(5_000_000n, { [deposit]: tokenAccount(TO, 0n) })),
  )
  const { instructions } = decode(candidate.transaction)
  expect(Array.from(instructions, (each) => each.programAddress)).toEqual([
    TOKEN_PROGRAM_ADDRESS,
    MEMO,
  ])
})

test('refuses what the wallet cannot send', async () => {
  await expect(
    tokenTransfer.build(intent, OWNER, context(await chain(1_499_999n))),
  ).rejects.toThrow('Not enough tokens')
  await expect(
    tokenTransfer.build(
      { ...intent, amount: '1.0000001' },
      OWNER,
      context(await chain(5_000_000n)),
    ),
  ).rejects.toThrow('6 decimals')
  await expect(
    tokenTransfer.build(
      { ...intent, recipient: OWNER },
      OWNER,
      context(await chain(5_000_000n)),
    ),
  ).rejects.toThrow('other than this wallet')
  await expect(
    tokenTransfer.build(
      { ...intent, mint: WSOL },
      OWNER,
      context(await chain(5_000_000n)),
    ),
  ).rejects.toThrow('not a token mint')
})

test('is a transfer-scope tool whose programs are already in the signer policy', () => {
  const tool = transactionTools.solana_token_transfer!
  expect(tool.scope).toBe('solana:transfer')
  expect(tool.operation).toBe(tokenTransfer)
  expect(tool.programs).toEqual(TOKEN_TRANSFER_PROGRAMS)
  const before = Object.entries(transactionTools)
    .filter(([name]) => name !== 'solana_token_transfer')
    .flatMap(([, each]) => each.programs)
  for (const program of TOKEN_TRANSFER_PROGRAMS)
    expect(before).toContain(program)
})
