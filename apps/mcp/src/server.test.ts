import { expect, mock, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { heliusTools } from '@lanatools/helius'
import { createServer } from './server'
import { chainFixtures } from '../scripts/verify-chain'
import type { ServerDependencies } from './server'

const identity = {
  grantId: '3665bb2c-0930-485a-97e2-3a431b5888d2',
  userId: 'user-1',
  clientId: 'client-1',
}
const address = '11111111111111111111111111111111'

async function connect(
  scopes = ['helius:read'],
  active = true,
  props: unknown = identity,
) {
  const api = {
    whoami: mock<ServerDependencies['api']['whoami']>(async () =>
      active ? { userId: identity.userId, clientId: identity.clientId } : null,
    ),
    walletAddress: mock<ServerDependencies['api']['walletAddress']>(
      async () => address,
    ),
    payHttp: mock<ServerDependencies['api']['payHttp']>(async () => ({
      ok: false,
      error: 'Not a payment test',
    })),
    callTool: mock<ServerDependencies['api']['callTool']>(async () => ({
      ok: true,
      result: { accounts: [] },
    })),
  }
  const revokeClient = mock<ServerDependencies['revokeClient']>(() => {})
  const server = createServer(
    { api, revokeClient, typesafeApiKey: undefined },
    props,
    scopes,
  )
  const client = new Client({ name: 'LanaTools test', version: '1.0.0' })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return {
    api,
    client,
    revokeClient,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

test('every package tool is registered with its metadata, schema, and read-only annotations', async () => {
  const session = await connect()
  try {
    const listed = (await session.client.listTools()).tools
    for (const tool of heliusTools) {
      const registered = listed.find((entry) => entry.name === tool.name)
      expect(registered).toBeDefined()
      expect(registered?.title).toBe(tool.title)
      expect(registered?.description).toBe(tool.description)
      expect(registered?.inputSchema.type).toBe('object')
      expect(registered?.inputSchema.properties).toEqual(expect.any(Object))
      expect(registered?.inputSchema.properties).not.toHaveProperty('network')
      expect(registered?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      })
    }
    expect(
      listed.filter((tool) =>
        heliusTools.some((entry) => entry.name === tool.name),
      ),
    ).toHaveLength(heliusTools.length)
    expect(session.api.whoami).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('a client without helius:read is not shown the Helius tools and cannot call them', async () => {
  const session = await connect(['account:read', 'payments:pay'])
  try {
    const names = (await session.client.listTools()).tools.map(
      (tool) => tool.name,
    )
    for (const tool of heliusTools) expect(names).not.toContain(tool.name)
    const result = await session.client
      .callTool({ name: 'get_accounts', arguments: { addresses: [address] } })
      .catch(() => ({ isError: true }))
    expect(result.isError).toBe(true)
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.callTool).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('a revoked grant is refused and its OAuth tokens are scheduled for revocation', async () => {
  const session = await connect(['helius:read'], false)
  session.api.callTool.mockImplementationOnce(async () => ({
    ok: false,
    error: {
      code: 'unauthorized',
      message: 'Connection revoked',
      retryable: false,
    },
  }))
  try {
    const result = await session.client.callTool({
      name: 'get_accounts',
      arguments: { addresses: [address] },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Connection revoked',
        retryable: false,
      },
    })
    expect(session.revokeClient).toHaveBeenCalledWith(identity)
    expect(session.api.whoami).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('invalid identities are refused before API calls', async () => {
  const session = await connect(['helius:read'], true, {
    ...identity,
    grantId: 'invalid',
  })
  try {
    expect(
      (
        await session.client.callTool({
          name: 'get_accounts',
          arguments: { addresses: [address] },
        })
      ).isError,
    ).toBe(true)
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.callTool).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('invalid addresses and caller-selected networks fail before any API call', async () => {
  const session = await connect()
  try {
    for (const args of [
      { addresses: ['not-an-address'] },
      { addresses: [address], network: 'mainnet-beta' },
    ]) {
      const result = await session.client.callTool({
        name: 'get_accounts',
        arguments: args,
      })
      expect(result.isError).toBe(true)
    }
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.callTool).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('valid calls forward identity and inputs and return matching JSON and structured content', async () => {
  const session = await connect()
  try {
    const result = await session.client.callTool({
      name: 'get_accounts',
      arguments: { addresses: [address] },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ accounts: [] })
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ])
    expect(session.api.callTool).toHaveBeenCalledTimes(1)
    expect(session.api.callTool.mock.calls[0]?.slice(0, 2)).toEqual([
      identity,
      'get_accounts',
    ])
    expect(session.api.callTool.mock.calls[0]?.[2]).toMatchObject({
      addresses: [address],
    })
    expect(session.revokeClient).not.toHaveBeenCalled()
    expect(
      (await session.client.callTool({ name: 'whoami', arguments: {} }))
        .isError,
    ).toBe(true)
  } finally {
    await session.close()
  }
})

test('API errors retain their code while unexpected RPC failures never expose details', async () => {
  const session = await connect()
  try {
    session.api.callTool.mockImplementationOnce(async () => ({
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Try again later',
        retryable: true,
      },
    }))
    const refused = await session.client.callTool({
      name: 'get_accounts',
      arguments: { addresses: [address] },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Try again later',
        retryable: true,
      },
    })
    expect(refused.content).toEqual([
      { type: 'text', text: JSON.stringify(refused.structuredContent) },
    ])
    session.api.callTool.mockImplementationOnce(async () => {
      throw new Error('provider.example/?api-key=never-leak-this')
    })
    const failed = await session.client.callTool({
      name: 'get_accounts',
      arguments: { addresses: [address] },
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('service_unavailable')
    expect(JSON.stringify(failed)).not.toContain('never-leak-this')
    session.api.whoami.mockImplementationOnce(async () => {
      throw new Error('another-secret')
    })
    const unavailable = await session.client.callTool({
      name: 'list_catalog',
      arguments: {},
    })
    expect(unavailable.isError).toBe(true)
    expect(JSON.stringify(unavailable)).not.toContain('another-secret')
  } finally {
    await session.close()
  }
})

test('every exported tool dispatches to the API through the shared grant boundary', async () => {
  const session = await connect()
  const fixtures = chainFixtures({ LANATOOLS_DEVNET_SIGNATURE: '1'.repeat(64) })
  try {
    for (const tool of heliusTools) {
      const result = await session.client.callTool({
        name: tool.name,
        arguments: fixtures.get(tool.name)!.input,
      })
      expect(result.isError).not.toBe(true)
      expect(session.api.callTool.mock.calls.at(-1)?.slice(0, 2)).toEqual([
        identity,
        tool.name,
      ])
    }
    // The API authorizes provider calls; the MCP Worker does not ask twice.
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.callTool).toHaveBeenCalledTimes(heliusTools.length)
  } finally {
    await session.close()
  }
})

test('each client sees the catalog and only the tool families it was given', async () => {
  const count = (names: string[], prefix: string) =>
    names.filter((name) => name.startsWith(prefix)).length
  const list = async (scopes: string[]) => {
    const session = await connect(scopes)
    try {
      return (await session.client.listTools()).tools.map((tool) => tool.name)
    } finally {
      await session.close()
    }
  }
  const catalogOnly = await list(['account:read'])
  expect(catalogOnly.sort()).toEqual(
    ['get_catalog_entry', 'list_catalog', 'search_catalog', 'whoami'].sort(),
  )

  const jupiter = await list(['account:read', 'jupiter:read'])
  expect(count(jupiter, 'jupiter_')).toBe(9)
  expect(count(jupiter, 'phoenix_')).toBe(0)
  expect(jupiter).not.toContain('call')

  const phoenix = await list(['account:read', 'phoenix:read'])
  expect(count(phoenix, 'phoenix_')).toBeGreaterThan(0)
  expect(count(phoenix, 'jupiter_')).toBe(0)

  const pay = await list(['account:read', 'payments:pay'])
  expect(pay).toContain('call')
  expect(pay).not.toContain('pay_http')
})

test('catalog tools work for any active grant', async () => {
  const session = await connect(['account:read'])
  try {
    const result = await session.client.callTool({
      name: 'list_catalog',
      arguments: {},
    })
    expect(result.isError).not.toBe(true)
    expect(session.api.whoami).toHaveBeenCalledWith(identity)
  } finally {
    await session.close()
  }
})

test('whoami returns the account, client and payment wallet address', async () => {
  const session = await connect(['account:read'])
  try {
    const result = await session.client.callTool({
      name: 'whoami',
      arguments: {},
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          userId: identity.userId,
          clientId: identity.clientId,
          walletAddress: address,
        }),
      },
    ])
    expect(session.api.walletAddress).toHaveBeenCalledWith(identity.userId)

    session.api.walletAddress.mockImplementationOnce(async () => null)
    const unset = await session.client.callTool({
      name: 'whoami',
      arguments: {},
    })
    expect(JSON.stringify(unset.content)).toContain('\\"walletAddress\\":null')
  } finally {
    await session.close()
  }
})

test('Jupiter and Phoenix calls go through the API like every provider', async () => {
  const session = await connect(['jupiter:read', 'phoenix:read'])
  try {
    session.api.callTool.mockImplementationOnce(async () => ({
      ok: true,
      result: { source: 'jupiter', data: { venues: {} } },
      summary: 'Returned 0 venue labels.',
    }))
    const venues = await session.client.callTool({
      name: 'jupiter_get_swap_venues',
      arguments: {},
    })
    expect(venues.content).toEqual([
      { type: 'text', text: 'Returned 0 venue labels.' },
      { type: 'text', text: JSON.stringify(venues.structuredContent) },
    ])
    await session.client.callTool({
      name: 'phoenix_get_market',
      arguments: { symbol: 'SOL' },
    })
    expect(session.api.callTool.mock.calls.map(([, name]) => name)).toEqual([
      'jupiter_get_swap_venues',
      'phoenix_get_market',
    ])
    const denied = await session.client
      .callTool({ name: 'get_accounts', arguments: { addresses: [address] } })
      .catch(() => ({ isError: true }))
    expect(denied.isError).toBe(true)
    expect(session.api.callTool).toHaveBeenCalledTimes(2)
  } finally {
    await session.close()
  }
})
