import { expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { JupiterClient } from './index'
import { formatJupiterResult, registerJupiterTools } from './mcp'

test('MCP discovers nine read-only schemas and calls them through the executor', async () => {
  const server = new McpServer({ name: 'jupiter-test', version: '1' })
  const reader = new JupiterClient({
    apiKey: 'server-key',
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/tokens/v2/search')
        return Response.json(
          new URL(url).searchParams.get('query') === 'JUP'
            ? []
            : [
                {
                  id: 'So11111111111111111111111111111111111111112',
                  decimals: 9,
                },
                {
                  id: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                  decimals: 6,
                },
              ],
        )
      if (path === '/swap/v2/order')
        return Response.json({
          inputMint: 'So11111111111111111111111111111111111111112',
          outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          inAmount: '1000000000',
          outAmount: '100000000',
          routePlan: [],
        })
      if (path.includes('getTriggerOrders'))
        return Response.json({ orders: [], hasMoreData: false })
      if (path === '/price/v3' || path === '/swap/v2/program-id-to-label')
        return Response.json({})
      return Response.json([])
    },
  })
  registerJupiterTools(server, async (request) =>
    formatJupiterResult(await reader.read(request)),
  )
  const client = new Client({ name: 'test-client', version: '1' })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      'jupiter_search_tokens',
      'jupiter_discover_tokens',
      'jupiter_get_prices',
      'jupiter_get_portfolio',
      'jupiter_get_lending_markets',
      'jupiter_get_lending_positions',
      'jupiter_get_trigger_orders',
      'jupiter_quote_swap',
      'jupiter_get_swap_venues',
    ])
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.annotations?.destructiveHint).toBe(false)
    }
    const result = await client.callTool({
      name: 'jupiter_search_tokens',
      arguments: { query: 'JUP' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      source: 'jupiter',
      data: { tokens: [] },
    })
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Returned 0 token records'),
      },
    ])
    const ranked = await client.callTool({
      name: 'jupiter_discover_tokens',
      arguments: { view: 'ranked', category: 'toptrending', interval: '24h' },
    })
    expect(ranked.structuredContent).toMatchObject({
      data: { view: 'ranked', pagination: { limit: 20 } },
    })
    const price = await client.callTool({
      name: 'jupiter_get_prices',
      arguments: { mints: ['So11111111111111111111111111111111111111112'] },
    })
    expect(price.structuredContent).toMatchObject({ data: { prices: {} } })
    const sol = 'So11111111111111111111111111111111111111112'
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    const remaining = [
      { name: 'jupiter_get_portfolio', arguments: { view: 'platforms' } },
      {
        name: 'jupiter_get_lending_markets',
        arguments: { view: 'borrow_vaults', market: 'ethena' },
      },
      {
        name: 'jupiter_get_lending_positions',
        arguments: { view: 'earn_positions', wallets: [sol] },
      },
      {
        name: 'jupiter_get_trigger_orders',
        arguments: {
          view: 'legacy_price_orders',
          wallet: sol,
          orderStatus: 'active',
        },
      },
      {
        name: 'jupiter_quote_swap',
        arguments: { inputMint: sol, outputMint: usdc, amount: '1' },
      },
      { name: 'jupiter_get_swap_venues', arguments: {} },
    ]
    for (const call of remaining) {
      const response = await client.callTool(call)
      expect(response.isError).not.toBe(true)
      expect(response.structuredContent).toMatchObject({
        source: 'jupiter',
        network: 'mainnet-beta',
      })
    }
  } finally {
    await client.close()
    await server.close()
  }
})

test('MCP errors expose the shared structured error contract', () => {
  const error = {
    code: 'permission_denied' as const,
    message: 'Jupiter access required',
    retryable: false,
  }
  const result = formatJupiterResult({ ok: false, error })
  expect(result.isError).toBe(true)
  expect(result.structuredContent).toEqual(error)
  expect(result.content).toEqual([
    { type: 'text', text: JSON.stringify(error) },
  ])
})
