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
  activationOf,
  activationTransaction,
  decodeMarketOrder,
  depositInstructions,
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
  expect(decodeMarketOrder(MARKET_ORDER_DATA)).toEqual({
    side: 'sell',
    priceInTicks: 10050n,
    numBaseLots: 3n,
    minBaseLotsToFill: 3n,
    lastValidSlot: 123n,
    reduceOnly: true,
  })
})

test('data that is not a market order decodes to null', () => {
  expect(decodeMarketOrder(new Uint8Array(8))).toBeNull()
  expect(decodeMarketOrder(MARKET_ORDER_DATA.slice(0, 20))).toBeNull()
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
