import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { createHeliusClient } from '../client'
import { getWalletHoldings } from './get-wallet-holdings'

const owner = '11111111111111111111111111111111'
const mixed = readFileSync(
  new URL('../fixtures/das-wallet-mixed.json', import.meta.url),
  'utf8',
)
const empty = readFileSync(
  new URL('../fixtures/das-wallet-empty.json', import.meta.url),
  'utf8',
)

async function run(body: string, input: Record<string, unknown> = {}) {
  const requests: Record<string, unknown>[] = []
  const ctx = createHeliusClient({
    rpcUrl: 'https://mainnet.helius-rpc.com/?api-key=fixture',
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(body, {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch,
  })
  const result = await getWalletHoldings.run(
    ctx,
    getWalletHoldings.input.parse({ owner, ...input }),
  )
  return { result, requests, credits: ctx.credits }
}

function envelope(result: unknown) {
  return JSON.stringify({ jsonrpc: '2.0', id: 'lanatools', result })
}

describe('get_wallet_holdings', () => {
  test('requests one DAS page with documented defaults and a 10-credit cost', async () => {
    const { requests, credits } = await run(mixed)
    expect(credits).toBe(10)
    expect(requests).toEqual([
      {
        jsonrpc: '2.0',
        id: 'lanatools',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: owner,
          limit: 20,
          sortBy: { sortBy: 'id', sortDirection: 'asc' },
          displayOptions: {
            showFungible: true,
            showNativeBalance: true,
            showZeroBalance: false,
          },
        },
      },
    ])
  })

  test('keeps Token-2022 balances lossless, unknown prices null, and totals page-scoped', async () => {
    const { result } = await run(mixed)
    expect(result.sol).toEqual({
      amount: '2.5',
      raw_amount: '2500000000',
      usd_price: 100,
      usd_value: 250,
    })
    expect(result.tokens).toEqual([
      {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        name: 'USD Coin',
        symbol: 'USDC',
        amount: '12.345678',
        raw_amount: '12345678',
        decimals: 6,
        program: 'SPL',
        token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        usd_price: 1,
        usd_value: 12.345678,
        price_currency: 'USDC',
      },
      {
        mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
        name: 'Synthetic Token-2022 Fixture',
        symbol: 'FIX',
        amount: '9007199.254740993',
        raw_amount: '9007199254740993',
        decimals: 9,
        program: 'Token-2022',
        token_program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
        usd_price: null,
        usd_value: null,
        price_currency: null,
      },
    ])
    expect(result.nft_count).toBe(1)
    expect(result.nft_count_scope).toBe('page')
    expect(result.nfts).toEqual([])
    expect(result.total_usd_value).toBeCloseTo(262.345678)
    expect(result.valuation).toEqual({
      scope: 'sol_and_selected_page_tokens',
      prices_complete: false,
      is_portfolio_total: false,
      nfts_included: false,
    })
    expect(result.next_cursor).toBe('upstream-next-page')
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  test('represents an empty wallet without inventing missing prices', async () => {
    const { result } = await run(empty)
    expect(result).toMatchObject({
      sol: { amount: '0', raw_amount: '0', usd_price: null, usd_value: null },
      tokens: [],
      nfts: [],
      nft_count: 0,
      total_usd_value: 0,
      next_cursor: null,
      valuation: { prices_complete: true },
    })
  })

  test('honors all, NFT-only, hide_zero=false, custom limit and upstream cursor', async () => {
    const { result, requests } = await run(mixed, {
      include: 'all',
      hide_zero: false,
      limit: 100,
      cursor: 'previous-page',
    })
    expect(result.tokens).toHaveLength(3)
    expect(result.nfts).toHaveLength(1)
    expect(result.nfts).toMatchObject([
      { compressed: true, collection: { verified: true } },
    ])
    expect(requests[0]?.params).toMatchObject({
      limit: 100,
      cursor: 'previous-page',
      displayOptions: { showZeroBalance: true },
    })
    const nfts = await run(mixed, { include: 'nfts' })
    expect(nfts.result.tokens).toEqual([])
    expect(nfts.result.nft_count).toBe(1)
    expect(nfts.result.total_usd_value).toBe(250)
  })

  test('preserves continuation when include filtering yields an empty page', async () => {
    const { result } = await run(
      envelope({
        items: [{ id: owner, interface: 'V1_NFT' }],
        cursor: 'next',
        nativeBalance: { lamports: 0 },
      }),
    )
    expect(result.tokens).toEqual([])
    expect(result.nfts).toEqual([])
    expect(result.next_cursor).toBe('next')
    expect(result.nft_count).toBe(1)
  })

  test('terminates an empty upstream page and rejects repeated nonempty cursors', async () => {
    const { result } = await run(envelope({ items: [], cursor: 'same' }), {
      cursor: 'same',
    })
    expect(result.next_cursor).toBeNull()
    await expect(
      run(
        envelope({
          items: [{ id: owner, interface: 'V1_NFT' }],
          cursor: 'same',
        }),
        { cursor: 'same' },
      ),
    ).rejects.toThrow()
  })

  test('missing native data, token amount, decimals or price remain unknown', async () => {
    const { result } = await run(
      envelope({ items: [{ id: owner, interface: 'FungibleToken' }] }),
    )
    expect(result.sol).toEqual({
      amount: null,
      raw_amount: null,
      usd_price: null,
      usd_value: null,
    })
    expect(result.tokens).toMatchObject([
      {
        amount: null,
        decimals: null,
        name: null,
        symbol: null,
        usd_price: null,
        usd_value: null,
      },
    ])
    expect(result.total_usd_value).toBeNull()
    expect(result.valuation).toMatchObject({ prices_complete: false })
  })

  test('does not relabel non-USD quotes or silently count unknown interfaces as NFTs', async () => {
    const { result } = await run(
      envelope({
        items: [
          {
            id: owner,
            interface: 'FungibleToken',
            token_info: {
              balance: 10,
              decimals: 0,
              price_info: {
                price_per_token: 2,
                total_price: 20,
                currency: 'EUR',
              },
            },
          },
          {
            id: 'So11111111111111111111111111111111111111112',
            interface: 'FutureAsset',
          },
        ],
      }),
    )
    expect(result.tokens).toMatchObject([
      { price_currency: 'EUR', usd_price: null, usd_value: null },
    ])
    expect(result.nft_count).toBe(0)
    expect(result.unknown_asset_count).toBe(1)
  })

  test('rejects malformed upstream results rather than reporting an empty wallet', async () => {
    for (const result of [
      null,
      {},
      { items: [null] },
      { items: [{ id: owner, token_info: { decimals: -1 } }] },
      { items: [], nativeBalance: { lamports: -1 } },
      { items: [], cursor: 123 },
      { items: [], cursor: 'x'.repeat(4097) },
    ]) {
      await expect(run(envelope(result))).rejects.toThrow()
    }
  })

  test('validates address, bounds, types and unknown fields before a request', () => {
    for (const input of [
      { owner: 'bad' },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { hide_zero: 'true' },
      { include: 'other' },
      { cursor: '' },
      { unexpected: true },
    ]) {
      expect(
        getWalletHoldings.input.safeParse({ owner, ...input }).success,
      ).toBe(false)
    }
  })
})

test('documented no-assets responses are empty pages, never invented zero SOL', async () => {
  for (const status of [200, 404]) {
    const ctx = createHeliusClient({
      rpcUrl: 'https://devnet.helius-rpc.com/?api-key=fixture',
      fetch: (async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: {
              code: -32004,
              message: 'No assets found for the specified owner.',
            },
          }),
          { status },
        )) as unknown as typeof fetch,
    })
    const result = await getWalletHoldings.run(
      ctx,
      getWalletHoldings.input.parse({ owner }),
    )
    expect(result).toMatchObject({
      tokens: [],
      nfts: [],
      nft_count: 0,
      next_cursor: null,
      sol: { amount: null, raw_amount: null },
      total_usd_value: null,
    })
    expect(ctx.credits).toBe(0)
  }
})
