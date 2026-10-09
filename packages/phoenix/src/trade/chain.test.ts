import { expect, test } from 'bun:test'
import { fetchAccount, tokenBalance } from './chain'
import { TOKEN_PROGRAM } from './checks'
import { WALLET, accountInfo, fakeRpc, tokenAccountData } from './fixtures'
import { PHOENIX_PROGRAM } from './rise'

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
