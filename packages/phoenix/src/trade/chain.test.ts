import { expect, test } from 'bun:test'
import {
  fetchAccount,
  positionSize,
  rentExemptMinimum,
  tokenBalance,
} from './chain'
import { TOKEN_PROGRAM } from './checks'
import { WALLET, accountInfo, fakeRpc, tokenAccountData } from './fixtures'
import { PHOENIX_PROGRAM, traderAccountAddress } from './rise'

test('an account is read from the chain in base64', async () => {
  const data = tokenAccountData(42n)
  const { rpc, calls } = fakeRpc({
    getAccountInfo: () => accountInfo(TOKEN_PROGRAM, data, 2_039_280n),
  })
  expect(await fetchAccount(rpc, WALLET)).toEqual({
    owner: TOKEN_PROGRAM,
    lamports: 2_039_280n,
    data,
  })
  expect(calls).toEqual([
    [
      'getAccountInfo',
      [WALLET, { encoding: 'base64', commitment: 'confirmed' }],
    ],
  ])
  const { rpc: empty } = fakeRpc({ getAccountInfo: () => ({ value: null }) })
  expect(await fetchAccount(empty, WALLET)).toBeNull()
})

test('a position is read from the account that holds it', async () => {
  const market = { symbol: 'GOLD', assetId: 65556, baseLotsDecimals: 3 }
  const accounts = async (
    position: typeof market & { subaccount?: number },
  ) => {
    const { rpc, calls } = fakeRpc({
      getAccountInfo: () => ({ value: null }),
    })
    expect(await positionSize(rpc, WALLET, position)).toBe('0')
    return calls.map(([, args]) => args[0])
  }
  expect(await accounts(market)).toEqual([await traderAccountAddress(WALLET)])
  expect(await accounts({ ...market, subaccount: 4 })).toEqual([
    await traderAccountAddress(WALLET, 4),
  ])
})

test("the rent floor is read for the account's own size", async () => {
  const { rpc, calls } = fakeRpc({
    getMinimumBalanceForRentExemption: () => 2_039_280n,
  })
  expect<bigint>(await rentExemptMinimum(rpc, 165)).toBe(2_039_280n)
  expect(calls).toEqual([['getMinimumBalanceForRentExemption', [165n]]])
})

test('a token balance is read only from a token account', () => {
  const owner = { lamports: 0n, data: tokenAccountData(5_000_000n) }
  expect(tokenBalance({ ...owner, owner: TOKEN_PROGRAM })).toBe(5_000_000n)
  expect(tokenBalance(null)).toBe(0n)
  expect(tokenBalance({ ...owner, owner: PHOENIX_PROGRAM })).toBe(0n)
  expect(
    tokenBalance({
      owner: TOKEN_PROGRAM,
      lamports: 0n,
      data: new Uint8Array(70),
    }),
  ).toBe(0n)
})
