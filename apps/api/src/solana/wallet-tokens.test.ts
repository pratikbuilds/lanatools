import { afterEach, expect, mock, test } from 'bun:test'
import { address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { walletTokens } from './wallet-tokens'
import { TOKEN_2022_PROGRAM } from './token-transfer'
import type { WithdrawalRpc } from './token-transfer'

const owner = address('F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3')
const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const account = address('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N')
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function rpcAccounts() {
  const calls: string[] = []
  const rpc = {
    getTokenAccountsByOwner: (
      _owner: string,
      { programId }: { programId: string },
    ) => ({
      send: async () => {
        calls.push(programId)
        return {
          value: [
            {
              pubkey: account,
              account: {
                owner: programId,
                data: {
                  parsed: {
                    info: {
                      mint,
                      state: 'initialized',
                      tokenAmount: {
                        amount:
                          programId === TOKEN_PROGRAM_ADDRESS
                            ? '1234567890123456789'
                            : '1',
                        decimals: 9,
                      },
                    },
                  },
                },
              },
            },
          ],
        }
      },
    }),
  } as unknown as WithdrawalRpc
  return { rpc, calls }
}

test('discovers both token programs, preserves exact balances and resolves metadata by mint', async () => {
  const { rpc, calls } = rpcAccounts()
  const requests: unknown[] = []
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({
      result: {
        id: mint,
        interface: 'FungibleToken',
        content: {
          metadata: { name: 'Example token', symbol: 'TEST' },
          links: { image: 'https://example.com/token.png' },
        },
        token_info: { decimals: 9 },
      },
    })
  }) as unknown as typeof fetch
  const tokens = await walletTokens(
    rpc,
    owner,
    'https://devnet.helius-rpc.com/?api-key=secret',
  )
  expect(calls).toEqual([TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM])
  expect(tokens.map((token) => token.amount)).toEqual([
    '1234567890123456789',
    '1',
  ])
  expect(
    tokens.every(
      (token) =>
        token.name === 'Example token' &&
        token.symbol === 'TEST' &&
        token.image === 'https://example.com/token.png',
    ),
  ).toBe(true)
  expect(requests).toHaveLength(1)
})

test('metadata failure leaves balances available, unsafe image schemes are omitted', async () => {
  const { rpc } = rpcAccounts()
  globalThis.fetch = mock(async () => {
    throw new Error('provider down')
  }) as unknown as typeof fetch
  const tokens = await walletTokens(rpc, owner, 'https://example.com')
  expect(tokens).toHaveLength(2)
  expect(tokens[0]?.name).toBeNull()
  expect(tokens[0]?.image).toBeNull()
  globalThis.fetch = mock(async () =>
    Response.json({
      result: {
        id: mint,
        content: { links: { image: 'javascript:alert(1)' } },
      },
    }),
  ) as unknown as typeof fetch
  expect(
    (await walletTokens(rpc, owner, 'https://example.com'))[0]?.image,
  ).toBeNull()
})
