import { decodeTrader } from '@ellipsis-labs/rise'
import { AccountRole, address } from '@solana/kit'
import type { Instruction } from '@solana/kit'
import { expect, test } from 'bun:test'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_PROGRAM,
  checkActivation,
  checkInstructions,
} from './checks'
import {
  BLOCKHASH,
  KEYS,
  MARKET_ORDER_DATA,
  ONBOARDER,
  OTHER,
  PERMISSION,
  TRADER_ACCOUNT_DATA,
  WALLET,
} from './fixtures'
import {
  EMBER_PROGRAM,
  PHOENIX_PROGRAM,
  SOL_ACCOUNTS,
  SYSTEM_PROGRAM,
  activationOf,
  activationTransaction,
  decodeOrder,
  depositInstructions,
  positionLots,
  solData,
  solDepositCredit,
  solDepositHeadroom,
  solDepositInstructions,
  solWithdrawInstruction,
  toInstruction,
  traderAccountAddress,
  withdrawInstructions,
} from './rise'
import { messageOf } from './transaction'

test('Rise instructions cross into kit 6 with their roles and bytes', () => {
  const instruction = toInstruction({
    programAddress: 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih',
    accounts: [
      { address: 'GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS', role: 0 },
      { address: WALLET, role: 2 },
      { address: '2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ', role: 1 },
    ],
    data: [1, 2, 3],
  })
  expect(instruction).toEqual({
    programAddress: PHOENIX_PROGRAM,
    accounts: [
      {
        address: address('GdxfTLSsdSY37G6fZoYtdGDSfgFnbT2EmRpuePZxWShS'),
        role: AccountRole.READONLY,
      },
      { address: WALLET, role: AccountRole.READONLY_SIGNER },
      {
        address: address('2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ'),
        role: AccountRole.WRITABLE,
      },
    ],
    data: Uint8Array.from([1, 2, 3]),
  })
})

test('an unknown role or address from Rise is refused', () => {
  const program = 'EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih'
  expect(() =>
    toInstruction({
      programAddress: program,
      accounts: [{ address: WALLET, role: 7 }],
    }),
  ).toThrow('unknown account role 7')
  expect(() => toInstruction({ programAddress: 'not-an-address' })).toThrow()
})

test('a real Rise market order decodes to its packet', () => {
  expect(decodeOrder(MARKET_ORDER_DATA)).toEqual({
    kind: 'market',
    side: 'sell',
    priceInTicks: 10050n,
    numBaseLots: 3n,
    minBaseLotsToFill: 3n,
    lastValidSlot: 123n,
    reduceOnly: true,
    slide: false,
    cancelExisting: false,
  })
})

test('data that is not an order decodes to null', () => {
  expect(decodeOrder(new Uint8Array(8))).toBeNull()
  expect(decodeOrder(MARKET_ORDER_DATA.slice(0, 20))).toBeNull()
})

const programsOf = (instructions: Instruction[]) =>
  instructions.map((instruction) => instruction.programAddress)

test('a deposit creates the Phoenix USD account, wraps USDC, and deposits', async () => {
  const instructions = await depositInstructions(WALLET, KEYS, 2_500_000n)
  expect(programsOf(instructions)).toEqual([
    ASSOCIATED_TOKEN_PROGRAM,
    EMBER_PROGRAM,
    PHOENIX_PROGRAM,
  ])
  expect(() =>
    checkInstructions(instructions, { wallet: WALLET }),
  ).not.toThrow()
})

test('a withdrawal unwraps through Ember after Phoenix releases it', async () => {
  const instructions = await withdrawInstructions(WALLET, KEYS, 1_000_000n)
  expect(programsOf(instructions)).toEqual([
    ASSOCIATED_TOKEN_PROGRAM,
    TOKEN_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    PHOENIX_PROGRAM,
    EMBER_PROGRAM,
  ])
  expect(() =>
    checkInstructions(instructions, { wallet: WALLET }),
  ).not.toThrow()
})

test('exchange keys that differ from the pinned SDK build nothing', async () => {
  await expect(
    depositInstructions(WALLET, { ...KEYS, globalConfig: address(OTHER) }, 1n),
  ).rejects.toMatchObject({ code: 'check_failed' })
})

test('a trader account is missing, or activated by its flags', () => {
  expect(activationOf(null)).toBe('missing')
  expect(activationOf(new Uint8Array())).toBe('missing')
  expect(activationOf(TRADER_ACCOUNT_DATA)).toBe('activated')
  expect(() => activationOf(new Uint8Array(40))).toThrow(
    'Could not read the Phoenix trader account',
  )
})

test("activation registers and onboards the wallet's own trader account", async () => {
  const traderAccount = await traderAccountAddress(WALLET)
  for (const register of [true, false]) {
    const { feePayer, instructions } = messageOf(
      await activationTransaction({
        wallet: WALLET,
        keys: KEYS,
        onboarder: PERMISSION.trader_onboarder,
        permissionAccount: PERMISSION.permission_account,
        referralCode: '4L2RQ06K',
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 500n,
        register,
      }),
    )
    expect(feePayer).toBe(WALLET)
    expect(instructions).toHaveLength(register ? 2 : 1)
    expect(() =>
      checkActivation(instructions, { traderAccount, register }),
    ).not.toThrow()
    expect(() =>
      checkInstructions(instructions, {
        wallet: WALLET,
        programs: [PHOENIX_PROGRAM],
        coSigners: [ONBOARDER],
      }),
    ).not.toThrow()
  }
})

test("a position is read from the trader account's own data", () => {
  const trader = decodeTrader(TRADER_ACCOUNT_DATA)
  const [first] = trader.positions.entries
  if (!first) throw new Error('the fixture holds positions')
  expect(positionLots(TRADER_ACCOUNT_DATA, Number(first.key))).toBe(
    BigInt(first.value.baseLotPosition),
  )
  expect(positionLots(TRADER_ACCOUNT_DATA, 9_999)).toBe(0n)
})

const ROOM = {
  caps: {
    maxPerTraderBalance: 1_000_000_000_000n,
    maxGlobalBalance: 50_000_000_000_000n,
    currGlobalBalance: 9_000_000_000_000n,
  },
  accountedLamports: 0n,
  traderMaxLamports: 1_000_000_000_000n,
  accountLamports: 1_000_000n,
  rentExemptLamports: 1_000_000n,
}

test('SOL headroom is the tighter cap, and comes from Rise', () => {
  expect(solDepositHeadroom(ROOM)).toBe(1_000_000_000_000n)
  // The trader's own cap, not the asset's, is the one that binds.
  expect(solDepositHeadroom({ ...ROOM, traderMaxLamports: 7n })).toBe(7n)
  expect(
    solDepositHeadroom({
      ...ROOM,
      caps: { ...ROOM.caps, currGlobalBalance: 49_999_999_999_990n },
    }),
  ).toBe(10n)
  expect(
    solDepositHeadroom({
      ...ROOM,
      accountedLamports: 400n,
      accountLamports: 1_000_400n,
      traderMaxLamports: 1_000n,
    }),
  ).toBe(600n)
})

test('uncounted lamports use up headroom; a rent deficit swallows credit', () => {
  const excess = {
    ...ROOM,
    accountLamports: 1_000_300n,
    traderMaxLamports: 1_000n,
  }
  expect(solDepositHeadroom(excess)).toBe(700n)
  expect(solDepositCredit(excess, 700n)).toBe(700n)

  const deficit = {
    ...ROOM,
    accountLamports: 999_900n,
    traderMaxLamports: 1_000n,
  }
  expect(solDepositHeadroom(deficit)).toBe(1_100n)
  expect(solDepositCredit(deficit, 150n)).toBe(50n)
  expect(solDepositCredit(deficit, 50n)).toBe(0n)
})

test('a SOL deposit is the three steps Rise documents, in order', async () => {
  const trader = await traderAccountAddress(WALLET)
  const [realloc, transfer, sync, ...rest] = await solDepositInstructions(
    WALLET,
    KEYS,
    10_000_000n,
  )
  expect(rest).toEqual([])
  expect(realloc?.programAddress).toBe(PHOENIX_PROGRAM)
  expect(realloc?.data).toEqual(solData.realloc())
  expect(transfer?.programAddress).toBe(SYSTEM_PROGRAM)
  expect(transfer?.data).toEqual(solData.transfer(10_000_000n))
  expect(transfer?.accounts).toEqual([
    { address: WALLET, role: AccountRole.WRITABLE_SIGNER },
    { address: trader, role: AccountRole.WRITABLE },
  ])
  expect(sync?.programAddress).toBe(PHOENIX_PROGRAM)
  expect(sync?.data).toEqual(solData.sync())
  expect(sync?.accounts?.[SOL_ACCOUNTS.sync.traderAccount]?.address).toBe(
    trader,
  )
})

test('a SOL withdrawal pays the wallet and leaves uncounted lamports alone', async () => {
  const instruction = await solWithdrawInstruction(WALLET, KEYS, 5_000_000n)
  const { trader, traderAccount, destination } = SOL_ACCOUNTS.withdraw
  expect(instruction.programAddress).toBe(PHOENIX_PROGRAM)
  const accounts = instruction.accounts ?? []
  expect(accounts.at(trader)).toEqual({
    address: WALLET,
    role: AccountRole.READONLY_SIGNER,
  })
  expect(accounts.at(traderAccount)?.address).toBe(
    await traderAccountAddress(WALLET),
  )
  expect(accounts.at(destination)?.address).toBe(WALLET)
  // Tag 2 is `withoutExcess`, then the amount as a u64.
  const data = Uint8Array.from(instruction.data ?? [])
  expect(data).toEqual(solData.withdraw(5_000_000n))
  expect(data[8]).toBe(2)
  expect(new DataView(data.buffer).getBigUint64(9, true)).toBe(5_000_000n)
})
