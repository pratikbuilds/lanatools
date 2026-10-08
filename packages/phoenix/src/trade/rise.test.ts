import { AccountRole, address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { MARKET_ORDER_DATA, WALLET } from './fixtures'
import { PHOENIX_PROGRAM, decodeMarketOrder, toInstruction } from './rise'

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
