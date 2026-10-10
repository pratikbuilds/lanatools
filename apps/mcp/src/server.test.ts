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
const requestId = 'da42e012-0d1b-4f4a-92db-086c7458a93d'
const review = {
  title: 'Send SOL',
  description: 'Send 0.01 SOL',
  actionLabel: 'Review transfer',
  fields: [{ label: 'Recipient', value: address }],
}
const transferInput = {
  recipient: address,
  amountLamports: '10000000',
  delivery: 'link',
  idempotencyKey: 'request-1',
}
const swapInput = {
  inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  outputMint: 'So11111111111111111111111111111111111111112',
  amount: '1',
  maxSlippageBps: 50,
  delivery: 'link',
  idempotencyKey: 'swap-request-1',
}
const transactionResult = {
  id: requestId,
  tool: 'solana_transfer',
  network: 'devnet',
  delivery: 'link',
  status: 'open',
  review,
  reviewUrl: `http://localhost:5173/tx/${requestId}`,
  signature: null,
  receipt: null,
  expiresAt: 1_900_000,
} as const
const TRANSACTION_SCOPES = ['account:read', 'jupiter:read', 'solana:transfer']

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
    createTransactionRequest: mock<
      ServerDependencies['api']['createTransactionRequest']
    >(async () => ({ ok: true, result: transactionResult })),
    transactionStatus: mock<ServerDependencies['api']['transactionStatus']>(
      async () => ({ ok: true, result: transactionResult }),
    ),
    sendTransaction: mock<ServerDependencies['api']['sendTransaction']>(
      async () => ({ ok: true, result: transactionResult }),
    ),
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
      'get_transaction_status',
      'send_transaction',
      'whoami',
    ].sort(),
  )

  const jupiter = await list(['account:read', 'jupiter:read'])
  expect(count(jupiter, 'jupiter_')).toBe(10)
  expect(jupiter).toContain('jupiter_swap')
  expect(jupiter).not.toContain('solana_transfer')

  expect(jupiter).not.toContain('solana_token_transfer')

  const transfer = await list(['account:read', 'solana:transfer'])
  expect(transfer).toContain('solana_transfer')
  expect(transfer).toContain('solana_token_transfer')
  expect(transfer).not.toContain('jupiter_swap')
  expect(count(jupiter, 'phoenix_')).toBe(0)
  expect(jupiter).not.toContain('call')

  const phoenix = await list(['account:read', 'phoenix:read'])
  expect(count(phoenix, 'phoenix_')).toBeGreaterThan(0)
  expect(count(phoenix, 'jupiter_')).toBe(0)
  expect(phoenix).not.toContain('phoenix_market_order')
  expect(phoenix).not.toContain('phoenix_activate_account')
  const trading = await list(['account:read', 'phoenix:trade'])
  expect(count(trading, 'phoenix_')).toBe(7)
  expect(trading).toContain('phoenix_activate_account')
  expect(trading).toContain('phoenix_market_order')
  expect(trading).not.toContain('phoenix_get_account')

  const pay = await list(['account:read', 'payments:pay'])
  expect(pay).toContain('call')
  expect(pay).not.toContain('pay_http')
})

test('each transaction tool is its own MCP tool with a flat input and the shared result', async () => {
  const session = await connect(TRANSACTION_SCOPES)
  try {
    const tools = (await session.client.listTools()).tools
    const names = tools.map((tool) => tool.name)
    for (const removed of ['create_transaction_link', 'jupiter_build_swap'])
      expect(names).not.toContain(removed)
    const transfer = tools.find((tool) => tool.name === 'solana_transfer')
    const tokens = tools.find((tool) => tool.name === 'solana_token_transfer')
    const swap = tools.find((tool) => tool.name === 'jupiter_swap')
    for (const tool of [transfer, tokens, swap]) {
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      })
      expect(tool?.inputSchema).not.toHaveProperty('anyOf')
      expect(tool?.inputSchema.properties).toMatchObject({
        delivery: { enum: ['link', 'local', 'embedded'] },
        wallet: { type: 'string' },
        idempotencyKey: { type: 'string' },
      })
      expect(tool?.inputSchema.required).not.toContain('wallet')
      expect(tool?.inputSchema.properties).not.toHaveProperty('network')
    }
    expect(transfer?.inputSchema.required).toEqual(
      expect.arrayContaining([
        'recipient',
        'amountLamports',
        'delivery',
        'idempotencyKey',
      ]),
    )
    expect(tokens?.inputSchema.required).toEqual(
      expect.arrayContaining([
        'recipient',
        'mint',
        'amount',
        'delivery',
        'idempotencyKey',
      ]),
    )
    expect(swap?.inputSchema.required).toEqual(
      expect.arrayContaining([
        'inputMint',
        'outputMint',
        'amount',
        'maxSlippageBps',
        'delivery',
        'idempotencyKey',
      ]),
    )

    for (const [name, input] of [
      ['solana_transfer', transferInput],
      ['jupiter_swap', swapInput],
    ] as const) {
      const created = await session.client.callTool({ name, arguments: input })
      expect(created.isError).not.toBe(true)
      expect(created.structuredContent).toEqual(transactionResult)
      expect(session.api.createTransactionRequest).toHaveBeenCalledWith(
        identity,
        name,
        input,
      )
    }
    expect(session.api.whoami).toHaveBeenCalledTimes(2)
    expect(session.api.callTool).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('transaction tools reject invalid intents and authority overrides before API access', async () => {
  const session = await connect(TRANSACTION_SCOPES)
  try {
    const { maxSlippageBps: _slippage, ...withoutSlippage } = swapInput
    const { delivery: _delivery, ...withoutDelivery } = transferInput
    const invalid = [
      ['solana_transfer', { ...transferInput, network: 'mainnet' }],
      ['solana_transfer', { ...transferInput, account: address }],
      ['solana_transfer', { ...transferInput, wallet: address }],
      ['solana_transfer', { ...transferInput, recipient: 'invalid' }],
      ['solana_transfer', { ...transferInput, amountLamports: '0' }],
      [
        'solana_transfer',
        { ...transferInput, amountLamports: '18446744073709551616' },
      ],
      ['solana_transfer', { ...transferInput, amountLamports: '0.01' }],
      ['solana_transfer', { ...transferInput, idempotencyKey: '' }],
      ['solana_transfer', { ...transferInput, delivery: 'local' }],
      [
        'solana_transfer',
        { ...transferInput, delivery: 'local', wallet: 'invalid' },
      ],
      [
        'solana_transfer',
        { ...transferInput, delivery: 'embedded', wallet: address },
      ],
      ['solana_transfer', withoutDelivery],
      ['jupiter_swap', withoutSlippage],
      ['jupiter_swap', { ...swapInput, network: 'mainnet' }],
      ['jupiter_swap', { ...swapInput, wallet: address }],
      ['jupiter_swap', { ...swapInput, maxSlippageBps: -1 }],
      ['jupiter_swap', { ...swapInput, outputMint: swapInput.inputMint }],
    ] as const
    for (const [name, input] of invalid) {
      const result = await session.client.callTool({ name, arguments: input })
      expect(result.isError).toBe(true)
    }
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.createTransactionRequest).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('a transaction tool needs its own scope', async () => {
  const session = await connect(['account:read', 'jupiter:read'])
  try {
    const result = await session.client
      .callTool({ name: 'solana_transfer', arguments: transferInput })
      .catch(() => ({ isError: true }))
    expect(result.isError).toBe(true)
    expect(session.api.createTransactionRequest).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('transaction tools refuse inactive or malformed connection identity', async () => {
  for (const [active, props] of [
    [false, identity],
    [true, { ...identity, grantId: 'invalid' }],
  ] as const) {
    const session = await connect(TRANSACTION_SCOPES, active, props)
    try {
      for (const [name, input] of [
        ['solana_transfer', transferInput],
        ['jupiter_swap', swapInput],
        ['get_transaction_status', { id: requestId }],
      ] as const) {
        const result = await session.client.callTool({ name, arguments: input })
        expect(result.isError).toBe(true)
      }
      expect(session.api.createTransactionRequest).not.toHaveBeenCalled()
      expect(session.api.transactionStatus).not.toHaveBeenCalled()
      if (!active) expect(session.revokeClient).toHaveBeenCalledWith(identity)
    } finally {
      await session.close()
    }
  }
})

test('transaction service failures are safe and API revocation still revokes the client', async () => {
  const session = await connect(TRANSACTION_SCOPES)
  try {
    session.api.createTransactionRequest.mockImplementationOnce(async () => {
      throw new Error('private-database-detail')
    })
    const failed = await session.client.callTool({
      name: 'solana_transfer',
      arguments: transferInput,
    })
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('service_unavailable')
    expect(JSON.stringify(failed)).not.toContain('private-database-detail')
    session.api.createTransactionRequest.mockImplementationOnce(async () => ({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Connection revoked',
        retryable: false,
      },
    }))
    const revoked = await session.client.callTool({
      name: 'solana_transfer',
      arguments: transferInput,
    })
    expect(revoked.isError).toBe(true)
    expect(session.revokeClient).toHaveBeenCalledWith(identity)
  } finally {
    await session.close()
  }
})

test('get_transaction_status returns the shared result for any active grant', async () => {
  const session = await connect(['account:read'])
  try {
    const result = await session.client.callTool({
      name: 'get_transaction_status',
      arguments: { id: requestId },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual(transactionResult)
    expect(session.api.transactionStatus).toHaveBeenCalledWith(
      identity,
      requestId,
    )
    session.api.transactionStatus.mockImplementationOnce(async () => ({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Connection revoked',
        retryable: false,
      },
    }))
    const revoked = await session.client.callTool({
      name: 'get_transaction_status',
      arguments: { id: requestId },
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

test('whoami returns only the payment wallet address', async () => {
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
    expect(unset.isError).not.toBe(true)
    expect(unset.content).toEqual([
      { type: 'text', text: JSON.stringify({ walletAddress: null }) },
    ])
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
