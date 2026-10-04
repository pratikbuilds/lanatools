import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { createHeliusClient } from '../client'
import { getTokenInfo } from './get-token-info'

const devnetUsdc = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
const nft = 'F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPoEZZdXJBsTTD2rk'
const token2022 = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
const absent = '11111111111111111111111111111111'
const devnetFixture = readFileSync(
  new URL('../fixtures/das-devnet-usdc.json', import.meta.url),
  'utf8',
)
const batchFixture = readFileSync(
  new URL('../fixtures/das-assets-batch.json', import.meta.url),
  'utf8',
)

async function run(body: string, ids = [devnetUsdc]) {
  const requests: Record<string, unknown>[] = []
  const ctx = createHeliusClient({
    rpcUrl: 'https://devnet.helius-rpc.com/?api-key=fixture',
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(body, {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })
  const result = await getTokenInfo.run(ctx, getTokenInfo.input.parse({ ids }))
  return { result, requests, credits: ctx.credits }
}

function envelope(result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id: 'lanatools', result })
}

describe('get_token_info', () => {
  test('uses getAsset for one ID and preserves devnet USDC decimals without metadata', async () => {
    const { result, requests, credits } = await run(devnetFixture)
    expect(requests).toEqual([
      {
        jsonrpc: '2.0',
        id: 'lanatools',
        method: 'getAsset',
        params: { id: devnetUsdc, options: { showFungible: true } },
      },
    ])
    expect(credits).toBe(10)
    expect(result).toMatchObject({
      assets: [
        {
          id: devnetUsdc,
          kind: 'token',
          name: null,
          symbol: null,
          decimals: 6,
          supply: '100000000000.000001',
          raw_supply: '100000000000000001',
          usd_price: null,
          program: 'SPL',
          mutable: true,
        },
      ],
      not_found: [],
    })
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  test('distinguishes an explicit revoked authority from an omitted unknown authority', async () => {
    const { result } = await run(devnetFixture)
    expect(result.assets).toMatchObject([
      {
        mint_authority: absent,
        mint_authority_status: 'present',
        freeze_authority: null,
        freeze_authority_status: 'revoked',
      },
    ])
    const unknown = await run(
      envelope({ id: devnetUsdc, interface: 'FungibleToken' }),
    )
    expect(unknown.result.assets).toMatchObject([
      {
        mint_authority: null,
        mint_authority_status: 'unknown',
        freeze_authority: null,
        freeze_authority_status: 'unknown',
      },
    ])
  })

  test('uses one batch request, matches by ID, preserves input order, and handles null entries', async () => {
    const { result, requests, credits } = await run(batchFixture, [
      token2022,
      absent,
      nft,
    ])
    expect(requests).toEqual([
      {
        jsonrpc: '2.0',
        id: 'lanatools',
        method: 'getAssetBatch',
        params: {
          ids: [token2022, absent, nft],
          options: { showFungible: true },
        },
      },
    ])
    expect(credits).toBe(10)
    expect(result.not_found).toEqual([absent])
    expect(result.assets).toMatchObject([
      {
        id: token2022,
        kind: 'token',
        name: 'Synthetic Token-2022 Fixture',
        symbol: 'FIX',
        program: 'Token-2022',
        supply: '18446744073.709551615',
        raw_supply: '18446744073709551615',
        usd_price: 0.25,
      },
      {
        id: nft,
        kind: 'nft',
        compressed: true,
        mutable: false,
        collection: {
          id: 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w',
          verified: false,
        },
        creators: [{ address: absent, share: 100, verified: true }],
      },
    ])
  })

  test('successful empty and all-null batch responses report the missing IDs', async () => {
    for (const result of [[], [null, null]]) {
      expect((await run(envelope(result), [nft, absent])).result).toEqual({
        assets: [],
        not_found: [nft, absent],
      })
    }
  })

  test('single null and explicit getAsset -32004 report not_found', async () => {
    for (const body of [
      envelope(null),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'lanatools',
        error: { code: -32004, message: 'secret provider text' },
      }),
    ]) {
      expect((await run(body)).result).toEqual({
        assets: [],
        not_found: [devnetUsdc],
      })
    }
  })

  test('a failed batch cannot establish which assets are missing', async () => {
    await expect(
      run(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'lanatools',
          error: { code: -32004, message: 'One or more missing' },
        }),
        [nft, absent],
      ),
    ).rejects.toThrow()
    await expect(
      run(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'lanatools',
          error: { code: -32000, message: 'Failure' },
        }),
      ),
    ).rejects.toThrow()
  })

  test('rejects malformed single/batch records and unrelated returned IDs', async () => {
    for (const result of [
      undefined,
      {},
      [],
      { id: absent },
      { id: devnetUsdc, token_info: { supply: -1 } },
      { id: devnetUsdc, token_info: { decimals: 2.5 } },
    ]) {
      await expect(run(envelope(result))).rejects.toThrow()
    }
    for (const result of [null, {}, [false], [{ id: devnetUsdc }]]) {
      await expect(run(envelope(result), [nft, absent])).rejects.toThrow()
    }
  })

  test('unknown programs and interfaces are not guessed', async () => {
    const { result } = await run(
      envelope({
        id: devnetUsdc,
        interface: 'FutureAsset',
        token_info: { token_program: absent },
      }),
    )
    expect(result.assets).toMatchObject([
      {
        kind: 'unknown',
        program: null,
        token_program: absent,
        mutable: null,
        decimals: null,
        supply: null,
      },
    ])
  })

  test('accepts 1–100 valid IDs and rejects invalid/extra input', () => {
    expect(
      getTokenInfo.input.safeParse({ ids: Array(100).fill(devnetUsdc) })
        .success,
    ).toBe(true)
    for (const input of [
      { ids: [] },
      { ids: Array(101).fill(devnetUsdc) },
      { ids: ['bad'] },
      { ids: devnetUsdc },
      { ids: [devnetUsdc], extra: true },
    ]) {
      expect(getTokenInfo.input.safeParse(input).success).toBe(false)
    }
  })
})

test('HTTP 404 is missing only with an explicit single-asset not-found code', async () => {
  const ctx = createHeliusClient({
    rpcUrl: 'https://devnet.helius-rpc.com/?api-key=fixture',
    fetch: (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32004, message: 'Asset not found' },
        }),
        { status: 404 },
      )) as unknown as typeof fetch,
  })
  expect(
    await getTokenInfo.run(
      ctx,
      getTokenInfo.input.parse({ ids: [devnetUsdc] }),
    ),
  ).toEqual({ assets: [], not_found: [devnetUsdc] })
  expect(ctx.credits).toBe(0)
})
