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
const linkId = 'da42e012-0d1b-4f4a-92db-086c7458a93d'
const review = {
  title: 'Send SOL',
  description: 'Send 0.01 SOL',
  actionLabel: 'Review transfer',
  fields: [{ label: 'Recipient', value: address }],
}
const transferInput = {
  tool: 'solana_transfer',
  arguments: { recipient: address, amountLamports: '10000000' },
  idempotencyKey: 'request-1',
}
const swapInput = {
  tool: 'jupiter_build_swap',
  arguments: {
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'So11111111111111111111111111111111111111112',
    amount: '1',
    maxSlippageBps: 50,
  },
  idempotencyKey: 'swap-request-1',
}

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
    sendFeedback: mock<ServerDependencies['api']['sendFeedback']>(
      async () => true,
    ),
    createTransactionLink: mock<
      ServerDependencies['api']['createTransactionLink']
    >(async () => ({
      ok: true,
      result: {
        linkId,
        reviewUrl: `http://localhost:5173/tx/${linkId}`,
        network: 'devnet',
        review,
        expiresAt: 1_900_000,
      },
    })),
    transactionLinkStatus: mock<
      ServerDependencies['api']['transactionLinkStatus']
    >(async () => ({
      ok: true,
      result: {
        id: linkId,
        tool: 'solana_transfer',
        network: 'devnet',
        review,
        status: 'open',
        account: null,
        signature: null,
        receipt: null,
        createdAt: 1_000_000,
        expiresAt: 1_900_000,
      },
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
    [
      'get_catalog_entry',
      'list_catalog',
      'search_catalog',
      'send_feedback',
      'create_transaction_link',
      'whoami',
    ].sort(),
  )

  const jupiter = await list(['account:read', 'jupiter:read'])
  expect(count(jupiter, 'jupiter_')).toBe(10)
  expect(count(jupiter, 'phoenix_')).toBe(0)
  expect(jupiter).not.toContain('call')

  const phoenix = await list(['account:read', 'phoenix:read'])
  expect(count(phoenix, 'phoenix_')).toBeGreaterThan(0)
  expect(count(phoenix, 'jupiter_')).toBe(0)

  const pay = await list(['account:read', 'payments:pay'])
  expect(pay).toContain('call')
  expect(pay).not.toContain('pay_http')
})

test('one transaction-link wrapper serves both operations without a new scope', async () => {
  const session = await connect([])
  try {
    const tools = (await session.client.listTools()).tools
    const wrapper = tools.find(
      (tool) => tool.name === 'create_transaction_link',
    )
    expect(wrapper?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    })
    expect(wrapper?.inputSchema).toMatchObject({
      anyOf: [
        {
          required: ['tool', 'arguments', 'idempotencyKey'],
          properties: {
            tool: { const: 'solana_transfer' },
            arguments: { required: ['recipient', 'amountLamports'] },
          },
        },
        {
          required: ['tool', 'arguments', 'idempotencyKey'],
          properties: {
            tool: { const: 'jupiter_build_swap' },
            arguments: {
              required: ['inputMint', 'outputMint', 'amount', 'maxSlippageBps'],
            },
          },
        },
      ],
    })
    expect(
      tools.filter((tool) => tool.name === 'create_transaction_link'),
    ).toHaveLength(1)
    for (const removed of [
      'solana_transfer',
      'jupiter_swap',
      'get_transaction_request',
    ]) {
      expect(tools.map((tool) => tool.name)).not.toContain(removed)
      const result = await session.client
        .callTool({ name: removed, arguments: {} })
        .catch(() => ({ isError: true }))
      expect(result.isError).toBe(true)
    }
    expect(tools.map((tool) => tool.name)).not.toContain('jupiter_build_swap')

    for (const input of [transferInput, swapInput]) {
      const created = await session.client.callTool({
        name: 'create_transaction_link',
        arguments: input,
      })
      expect(created.isError).not.toBe(true)
      expect(created.structuredContent).toMatchObject({ linkId })
      expect(created.content).toEqual([
        { type: 'text', text: JSON.stringify(created.structuredContent) },
      ])
      expect(session.api.createTransactionLink).toHaveBeenCalledWith(
        identity,
        input.tool,
        { ...input.arguments, idempotencyKey: input.idempotencyKey },
      )
    }
    expect(session.api.whoami).toHaveBeenCalledTimes(2)
    expect(session.api.callTool).not.toHaveBeenCalled()
    expect(session.api.transactionLinkStatus).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('the link wrapper rejects invalid intents, authority overrides and unsupported tools before API access', async () => {
  const session = await connect([])
  try {
    const { maxSlippageBps: _slippage, ...withoutSlippage } =
      swapInput.arguments
    const invalidTransfers = [
      { ...transferInput.arguments, network: 'mainnet' },
      { ...transferInput.arguments, account: address },
      { ...transferInput.arguments, wallet: address },
      { ...transferInput.arguments, idempotencyKey: 'nested-key' },
      { ...transferInput.arguments, recipient: 'invalid' },
      { ...transferInput.arguments, amountLamports: '0' },
      { ...transferInput.arguments, amountLamports: '18446744073709551616' },
      { ...transferInput.arguments, amountLamports: '0.01' },
    ].map((args) => ({ ...transferInput, arguments: args }))
    const invalidSwaps = [
      withoutSlippage,
      { ...swapInput.arguments, network: 'mainnet' },
      { ...swapInput.arguments, wallet: address },
      { ...swapInput.arguments, account: address },
      { ...swapInput.arguments, maxSlippageBps: -1 },
      { ...swapInput.arguments, outputMint: swapInput.arguments.inputMint },
      { ...swapInput.arguments, idempotencyKey: 'nested-key' },
    ].map((args) => ({ ...swapInput, arguments: args }))
    for (const input of [
      ...invalidTransfers,
      ...invalidSwaps,
      { ...transferInput, network: 'mainnet' },
      { ...transferInput, wallet: address },
      { ...transferInput, idempotencyKey: '' },
      { ...transferInput, tool: 'unknown_transaction' },
      { ...transferInput, tool: 'jupiter_swap' },
      { ...transferInput, tool: 'jupiter_quote_swap' },
      {
        ...transferInput,
        tool: 'get_accounts',
        arguments: { addresses: [address] },
      },
      { ...transferInput, tool: '__proto__' },
    ]) {
      const result = await session.client.callTool({
        name: 'create_transaction_link',
        arguments: input,
      })
      expect(result.isError).toBe(true)
    }
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.createTransactionLink).not.toHaveBeenCalled()
    expect(session.api.callTool).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('the raw Jupiter build tool retains provider scope and wallet input beside the link wrapper', async () => {
  const session = await connect(['jupiter:read'])
  try {
    const tools = (await session.client.listTools()).tools
    expect(
      tools.find((tool) => tool.name === 'jupiter_build_swap')?.inputSchema
        .required,
    ).toContain('wallet')
    expect(
      tools.filter((tool) => tool.name === 'create_transaction_link'),
    ).toHaveLength(1)
    const input = { ...swapInput.arguments, wallet: address }
    expect(
      await session.client.callTool({
        name: 'jupiter_build_swap',
        arguments: input,
      }),
    ).not.toHaveProperty('isError', true)
    expect(session.api.callTool).toHaveBeenCalledWith(
      identity,
      'jupiter_build_swap',
      input,
    )
    expect(session.api.createTransactionLink).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('the link wrapper refuses inactive or malformed connection identity', async () => {
  for (const [active, props] of [
    [false, identity],
    [true, { ...identity, grantId: 'invalid' }],
  ] as const) {
    const session = await connect([], active, props)
    try {
      for (const args of [transferInput, swapInput]) {
        const result = await session.client.callTool({
          name: 'create_transaction_link',
          arguments: args,
        })
        expect(result.isError).toBe(true)
      }
      expect(session.api.createTransactionLink).not.toHaveBeenCalled()
      if (!active) expect(session.revokeClient).toHaveBeenCalledWith(identity)
    } finally {
      await session.close()
    }
  }
})

test('transaction service failures are safe and API revocation still revokes the client', async () => {
  const session = await connect([])
  try {
    session.api.createTransactionLink.mockImplementationOnce(async () => {
      throw new Error('private-database-detail')
    })
    const failed = await session.client.callTool({
      name: 'create_transaction_link',
      arguments: transferInput,
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('service_unavailable')
    expect(JSON.stringify(failed)).not.toContain('private-database-detail')
    session.api.createTransactionLink.mockImplementationOnce(async () => ({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Connection revoked',
        retryable: false,
      },
    }))
    const revoked = await session.client.callTool({
      name: 'create_transaction_link',
      arguments: transferInput,
    })
    expect(revoked.isError).toBe(true)
    expect(session.revokeClient).toHaveBeenCalledWith(identity)
  } finally {
    await session.close()
  }
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

test('send_feedback saves the text for the connected client', async () => {
  const session = await connect(['account:read'])
  try {
    const result = await session.client.callTool({
      name: 'send_feedback',
      arguments: { feedback: '  get_accounts gave no hint about the error  ' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ saved: true }) },
    ])
    expect(session.api.sendFeedback).toHaveBeenCalledWith(
      identity,
      'get_accounts gave no hint about the error',
    )

    const empty = await session.client
      .callTool({ name: 'send_feedback', arguments: { feedback: '   ' } })
      .catch(() => ({ isError: true }))
    expect(empty.isError).toBe(true)
    expect(session.api.sendFeedback).toHaveBeenCalledTimes(1)
  } finally {
    await session.close()
  }
})

test('send_feedback refuses a revoked client and hides API failures', async () => {
  const session = await connect(['account:read'])
  try {
    session.api.sendFeedback.mockImplementationOnce(async () => false)
    const revoked = await session.client.callTool({
      name: 'send_feedback',
      arguments: { feedback: 'Unclear error' },
    })
    expect(revoked.structuredContent).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Connection revoked',
        retryable: false,
      },
    })
    expect(session.revokeClient).toHaveBeenCalledWith(identity)

    session.api.sendFeedback.mockImplementationOnce(async () => {
      throw new Error('d1-detail-never-leak')
    })
    const failed = await session.client.callTool({
      name: 'send_feedback',
      arguments: { feedback: 'Unclear error' },
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('service_unavailable')
    expect(JSON.stringify(failed)).not.toContain('d1-detail-never-leak')
  } finally {
    await session.close()
  }
})
