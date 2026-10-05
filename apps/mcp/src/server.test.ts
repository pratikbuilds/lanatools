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
    readJupiter: mock<ServerDependencies['api']['readJupiter']>(async () => ({
      ok: false,
      error: {
        code: 'upstream_unavailable',
        message: 'Test upstream unavailable',
        retryable: true,
      },
    })),
    payHttp: mock<ServerDependencies['api']['payHttp']>(async () => ({
      ok: false,
      error: 'Not a payment test',
    })),
    runTool: mock<ServerDependencies['api']['runTool']>(async () => ({
      ok: true,
      result: { accounts: [] },
      credits: 1,
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
    expect(session.api.runTool).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('a revoked grant is refused and its OAuth tokens are scheduled for revocation', async () => {
  const session = await connect(['helius:read'], false)
  try {
    const result = await session.client.callTool({
      name: 'get_accounts',
      arguments: { addresses: [address] },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error: { code: 'unauthorized', message: 'Connection revoked' },
    })
    expect(session.revokeClient).toHaveBeenCalledWith(identity)
    expect(session.api.runTool).not.toHaveBeenCalled()
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
    expect(session.api.runTool).not.toHaveBeenCalled()
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
    expect(session.api.runTool).not.toHaveBeenCalled()
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
    expect(session.api.runTool).toHaveBeenCalledTimes(1)
    expect(session.api.runTool.mock.calls[0]?.slice(0, 4)).toEqual([
      identity.grantId,
      identity.userId,
      identity.clientId,
      'get_accounts',
    ])
    expect(session.api.runTool.mock.calls[0]?.[4]).toMatchObject({
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
    session.api.runTool.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'rate_limited', message: 'Try again later' },
      credits: 0,
    }))
    const refused = await session.client.callTool({
      name: 'get_accounts',
      arguments: { addresses: [address] },
    })
    expect(refused.isError).toBe(true)
    expect(refused.structuredContent).toEqual({
      error: { code: 'rate_limited', message: 'Try again later' },
    })
    expect(refused.content).toEqual([
      { type: 'text', text: JSON.stringify(refused.structuredContent) },
    ])
    session.api.runTool.mockImplementationOnce(async () => {
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
      name: 'get_accounts',
      arguments: { addresses: [address] },
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
      expect(session.api.runTool.mock.calls.at(-1)?.slice(0, 4)).toEqual([
        identity.grantId,
        identity.userId,
        identity.clientId,
        tool.name,
      ])
    }
    expect(session.api.whoami).toHaveBeenCalledTimes(heliusTools.length)
    expect(session.api.runTool).toHaveBeenCalledTimes(heliusTools.length)
  } finally {
    await session.close()
  }
})

test('each client sees the catalog and only the tool families it was given', async () => {
  const families = {
    jupiter: (names: string[]) =>
      names.filter((name) => name.startsWith('jupiter_')).length,
    phoenix: (names: string[]) =>
      names.filter((name) => name.startsWith('phoenix_')).length,
  }
  const list = async (scopes: string[]) => {
    const session = await connect(scopes)
    try {
      return (await session.client.listTools()).tools.map((tool) => tool.name)
    } finally {
      await session.close()
    }
  }
  const catalogOnly = await list(['account:read'])
  expect(catalogOnly).toEqual(
    expect.arrayContaining([
      'whoami',
      'list_catalog',
      'search_catalog',
      'get_catalog_entry',
    ]),
  )
  expect(catalogOnly).toHaveLength(4)

  const jupiter = await list(['account:read', 'jupiter:read'])
  expect(families.jupiter(jupiter)).toBe(9)
  expect(families.phoenix(jupiter)).toBe(0)
  expect(jupiter).not.toContain('call')

  const phoenix = await list(['account:read', 'phoenix:read'])
  expect(families.phoenix(phoenix)).toBeGreaterThan(0)
  expect(families.jupiter(phoenix)).toBe(0)

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
    expect(session.api.whoami).toHaveBeenCalledWith(
      identity.grantId,
      identity.userId,
      identity.clientId,
    )
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
