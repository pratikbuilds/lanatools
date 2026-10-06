import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { listMcpClients, setMcpClientOutgoing } from './mcp-clients'

const request = spyOn(globalThis, 'fetch')
afterAll(() => request.mockRestore())
afterEach(() => request.mockReset())

test('an older API client list keeps clients visible with automatic permission off during rollout', async () => {
  request.mockResolvedValue(
    Response.json({
      clients: [
        {
          grantId: 'grant-1',
          clientId: 'client-1',
          clientName: 'Existing client',
          redirectHost: 'client.test',
          scopes: ['account:read'],
          connectedAt: 123,
          lastUsedAt: null,
          limitMicroUsd: 0,
          spentMicroUsd: 0,
          reservedMicroUsd: 0,
          estimatedCredits: 0,
        },
      ],
    }),
  )
  const result = await listMcpClients(async () => 'owner-token')
  expect(result[0]?.clientName).toBe('Existing client')
  expect(result[0]?.outgoingAllowed).toBe(false)
})

test('outgoing permission saves the explicit value with owner authentication and an encoded grant', async () => {
  request.mockResolvedValue(new Response(null, { status: 204 }))
  for (const allowed of [true, false]) {
    await setMcpClientOutgoing(async () => 'owner-token', 'grant/one', allowed)
    expect(request).toHaveBeenLastCalledWith(
      '/api/mcp/clients/grant%2Fone/outgoing',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ allowed }),
      },
    )
  }
})

test('an unsigned-in owner cannot send a permission change', async () => {
  await expect(
    setMcpClientOutgoing(async () => null, 'grant-1', true),
  ).rejects.toThrow('Sign in again')
  expect(request).not.toHaveBeenCalled()
})

test('refused, revoked and unavailable permission changes remain failures', async () => {
  for (const status of [401, 403, 404, 500]) {
    request.mockResolvedValue(new Response(null, { status }))
    await expect(
      setMcpClientOutgoing(async () => 'owner-token', 'grant-1', true),
    ).rejects.toThrow('Could not change the outgoing permission')
  }
  request.mockRejectedValue(new Error('Connection lost'))
  await expect(
    setMcpClientOutgoing(async () => 'owner-token', 'grant-1', true),
  ).rejects.toThrow('Connection lost')
})
