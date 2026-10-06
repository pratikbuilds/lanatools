import { expect, mock, test } from 'bun:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { heliusTools } from '@lanatools/helius'
import type { TransactionResult } from '@lanatools/contracts'
import { createServer } from './server'
import { chainFixtures } from '../scripts/verify-chain'
import type { ServerDependencies } from './server'

const identity = {
  grantId: '3665bb2c-0930-485a-97e2-3a431b5888d2',
  userId: 'user-1',
  clientId: 'client-1',
}
const address = '11111111111111111111111111111111'
const transferResult: TransactionResult = {
  requestId: '522b313e-3011-45bb-95ed-fd65ee54f1d9',
  state: 'uncertain',
  attemptId: 'attempt-1',
  signature: 'signature-1',
  reason: 'Submission outcome is unknown',
}

test('embedded transfer returns safe metadata and preserves the exact amount for any active grant', async () => {
  const session = await connect([])
  try {
    const input = {
      idempotencyKey: 'embedded-1',
      recipient: address,
      amountLamports: '18446744073709551615',
    }
    const result = await session.client.callTool({
      name: 'transfer_sol_embedded',
      arguments: input,
    })
    expect(result.isError).not.toBe(true)
    expect(session.api.whoami).toHaveBeenCalledWith(identity)
    expect(session.api.executeEmbeddedTransfer).toHaveBeenCalledTimes(1)
    expect(session.api.executeEmbeddedTransfer).toHaveBeenCalledWith(
      identity,
      input,
    )
    expect(result.structuredContent).toEqual(transferResult)
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(transferResult) },
    ])
    expect(session.api.payHttp).not.toHaveBeenCalled()
    expect(session.api.createExternalTransfer).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('embedded transfer rejects malformed amounts and caller-selected authority before API calls', async () => {
  const session = await connect([])
  try {
    const input = {
      idempotencyKey: 'strict-embedded',
      recipient: address,
      amountLamports: '1',
    }
    for (const invalid of [
      { ...input, idempotencyKey: '' },
      { ...input, idempotencyKey: 'x'.repeat(129) },
      { ...input, recipient: 'x'.repeat(31) },
      { ...input, recipient: 'x'.repeat(45) },
      { ...input, amountLamports: '0' },
      { ...input, amountLamports: '-1' },
      { ...input, amountLamports: '1.5' },
      { ...input, amountLamports: '1e9' },
      { ...input, amountLamports: '18446744073709551616' },
      { ...input, amountLamports: 1 },
      { ...input, externalWallet: address },
      { ...input, walletId: 'wallet-1' },
      { ...input, outgoingAllowed: true },
      { ...input, instructions: [] },
      { ...input, network: 'mainnet' },
    ]) {
      const result = await session.client.callTool({
        name: 'transfer_sol_embedded',
        arguments: invalid,
      })
      expect(result.isError).toBe(true)
    }
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.executeEmbeddedTransfer).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('embedded permission refusals return the safe reason without a signing link', async () => {
  const session = await connect([])
  session.api.executeEmbeddedTransfer.mockImplementationOnce(async () => ({
    ok: false,
    reason: 'Transaction delegation is not enabled',
  }))
  try {
    const result = await session.client.callTool({
      name: 'transfer_sol_embedded',
      arguments: {
        idempotencyKey: 'disabled',
        recipient: address,
        amountLamports: '1',
      },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toEqual({
      error: {
        code: 'transaction_refused',
        message: 'Transaction delegation is not enabled',
        retryable: false,
      },
    })
    expect(session.api.createExternalTransfer).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('status lookup forwards only the owned request ID and returns verified safe metadata', async () => {
  const session = await connect([])
  try {
    const result = await session.client.callTool({
      name: 'get_transfer_status',
      arguments: { requestId: transferResult.requestId },
    })
    expect(result.isError).not.toBe(true)
    expect(session.api.getTransferStatus).toHaveBeenCalledWith(
      identity,
      transferResult.requestId,
    )
    expect(result.structuredContent).toEqual(transferResult)
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(transferResult) },
    ])
    expect(session.api.executeEmbeddedTransfer).not.toHaveBeenCalled()
    for (const invalid of [
      { requestId: 'not-a-uuid' },
      { requestId: transferResult.requestId, userId: 'another-user' },
    ]) {
      expect(
        (
          await session.client.callTool({
            name: 'get_transfer_status',
            arguments: invalid,
          })
        ).isError,
      ).toBe(true)
    }
    expect(session.api.getTransferStatus).toHaveBeenCalledTimes(1)
    expect(session.api.whoami).toHaveBeenCalledTimes(1)
  } finally {
    await session.close()
  }
})

test('revoked grants cannot execute embedded transfers or read their status', async () => {
  const session = await connect([], false)
  try {
    for (const call of [
      {
        name: 'transfer_sol_embedded',
        arguments: {
          idempotencyKey: 'revoked',
          recipient: address,
          amountLamports: '1',
        },
      },
      {
        name: 'get_transfer_status',
        arguments: { requestId: transferResult.requestId },
      },
    ]) {
      const result = await session.client.callTool(call)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'unauthorized' },
      })
    }
    expect(session.api.executeEmbeddedTransfer).not.toHaveBeenCalled()
    expect(session.api.getTransferStatus).not.toHaveBeenCalled()
    expect(session.revokeClient).toHaveBeenCalledWith(identity)
  } finally {
    await session.close()
  }
})

test('embedded execution and status service failures never expose signing details', async () => {
  const session = await connect([])
  session.api.executeEmbeddedTransfer.mockImplementationOnce(async () => {
    throw new Error('private signer key')
  })
  session.api.getTransferStatus.mockImplementationOnce(async () => {
    throw new Error('private RPC key')
  })
  try {
    for (const call of [
      {
        name: 'transfer_sol_embedded',
        arguments: {
          idempotencyKey: 'unavailable',
          recipient: address,
          amountLamports: '1',
        },
      },
      {
        name: 'get_transfer_status',
        arguments: { requestId: transferResult.requestId },
      },
    ]) {
      const result = await session.client.callTool(call)
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        error: { code: 'service_unavailable', retryable: true },
      })
      expect(JSON.stringify(result)).not.toContain('private')
    }
  } finally {
    await session.close()
  }
})

test('an active grant creates one action signing link without account or payment scopes', async () => {
  const session = await connect([])
  try {
    const listed = (await session.client.listTools()).tools
    const tool = listed.find((item) => item.name === 'transfer_sol_external')
    expect(tool?.inputSchema.additionalProperties).toBe(false)
    const input = {
      idempotencyKey: 'external-transfer-1',
      recipient: address,
      amountLamports: '18446744073709551615',
    }
    const result = await session.client.callTool({
      name: 'transfer_sol_external',
      arguments: input,
    })
    expect(result.isError).not.toBe(true)
    expect(session.api.whoami).toHaveBeenCalledWith(identity)
    expect(session.api.createExternalTransfer).toHaveBeenCalledTimes(1)
    expect(session.api.createExternalTransfer).toHaveBeenCalledWith(identity, {
      ...input,
      externalWallet: null,
    })
    expect(result.structuredContent).toEqual({
      requestId: 'request-1',
      signingUrl: 'http://localhost:5173/sign#single-action-token',
      expiresAt: 1_800_000_000_000,
    })
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify(result.structuredContent) },
    ])
    expect(session.api.walletAddress).not.toHaveBeenCalled()
    expect(session.api.payHttp).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('external transfer preserves an expected wallet and an exact large amount', async () => {
  const session = await connect([])
  try {
    const input = {
      idempotencyKey: 'expected-wallet',
      recipient: address,
      amountLamports: '9007199254740993',
      externalWallet: address,
    }
    const result = await session.client.callTool({
      name: 'transfer_sol_external',
      arguments: input,
    })
    expect(result.isError).not.toBe(true)
    expect(session.api.createExternalTransfer).toHaveBeenCalledTimes(1)
    expect(session.api.createExternalTransfer).toHaveBeenCalledWith(
      identity,
      input,
    )
  } finally {
    await session.close()
  }
})

test('external transfer rejects malformed intent before authorizing or creating a link', async () => {
  const session = await connect([])
  try {
    const input = {
      idempotencyKey: 'strict-input',
      recipient: address,
      amountLamports: '1',
    }
    for (const invalid of [
      { ...input, idempotencyKey: '' },
      { ...input, idempotencyKey: 'x'.repeat(129) },
      { ...input, recipient: 'x'.repeat(31) },
      { ...input, recipient: 'x'.repeat(45) },
      { ...input, amountLamports: '0' },
      { ...input, amountLamports: '-1' },
      { ...input, amountLamports: '1.5' },
      { ...input, amountLamports: '1e9' },
      { ...input, amountLamports: '18446744073709551616' },
      { ...input, amountLamports: 1 },
      { ...input, network: 'mainnet' },
      { ...input, instructions: [] },
      { ...input, externalWallet: 1 },
    ]) {
      const result = await session.client.callTool({
        name: 'transfer_sol_external',
        arguments: invalid,
      })
      expect(result.isError).toBe(true)
    }
    expect(session.api.whoami).not.toHaveBeenCalled()
    expect(session.api.createExternalTransfer).not.toHaveBeenCalled()
  } finally {
    await session.close()
  }
})

test('a revoked grant cannot create an external signing link', async () => {
  const session = await connect([], false)
  try {
    const result = await session.client.callTool({
      name: 'transfer_sol_external',
      arguments: {
        idempotencyKey: 'revoked',
        recipient: address,
        amountLamports: '1',
      },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'unauthorized', retryable: false },
    })
    expect(session.api.createExternalTransfer).not.toHaveBeenCalled()
    expect(session.revokeClient).toHaveBeenCalledWith(identity)
  } finally {
    await session.close()
  }
})

test('external transfer service failures do not expose capability or RPC details', async () => {
  const session = await connect([])
  session.api.createExternalTransfer.mockImplementationOnce(async () => {
    throw new Error('private signing capability and rpc-key')
  })
  try {
    const result = await session.client.callTool({
      name: 'transfer_sol_external',
      arguments: {
        idempotencyKey: 'unavailable',
        recipient: address,
        amountLamports: '1',
      },
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({
      error: { code: 'service_unavailable', retryable: true },
    })
    expect(JSON.stringify(result)).not.toContain('private signing capability')
  } finally {
    await session.close()
  }
})

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
    createExternalTransfer: mock<
      ServerDependencies['api']['createExternalTransfer']
    >(async () => ({
      requestId: 'request-1',
      signingUrl: 'http://localhost:5173/sign#single-action-token',
      expiresAt: 1_800_000_000_000,
    })),
    executeEmbeddedTransfer: mock<
      ServerDependencies['api']['executeEmbeddedTransfer']
    >(async () => ({ ok: true, result: transferResult })),
    getTransferStatus: mock<ServerDependencies['api']['getTransferStatus']>(
      async () => transferResult,
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
      'transfer_sol_external',
      'transfer_sol_embedded',
      'get_transfer_status',
      'whoami',
    ].sort(),
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
