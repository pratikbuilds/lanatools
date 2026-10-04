import { expect, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { JupiterClient } from './index'
import { formatJupiterResult, registerJupiterTools } from './mcp'

test('MCP discovers three read-only schemas and calls them through the executor', async () => {
  const server = new McpServer({ name: 'jupiter-test', version: '1' })
  const reader = new JupiterClient({
    apiKey: 'server-key',
    fetch: (url) =>
      Promise.resolve(
        Response.json(new URL(url).pathname === '/price/v3' ? {} : []),
      ),
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
