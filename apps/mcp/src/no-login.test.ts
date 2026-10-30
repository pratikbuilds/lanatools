import { beforeEach, expect, test } from 'bun:test'
import { api, env, noLogin, resetWorker, send } from './test-worker'

beforeEach(resetWorker)

/** Posts one MCP JSON-RPC message, with a token when one is given. */
function rpc(method: string, params: unknown, token?: string) {
  return send('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      // Request does not set Host itself; the MCP handler requires it.
      Host: new URL(env.MCP_ORIGIN).host,
      'CF-Connecting-IP': '203.0.113.7',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/** The JSON-RPC reply, whether it came as JSON or as one SSE event. */
async function reply(response: Response) {
  const text = await response.text()
  const data = text.startsWith('{')
    ? text
    : (/^data: (.+)$/m.exec(text)?.[1] ?? '')
  return JSON.parse(data)
}

const callTool = (name: string, token?: string, args: unknown = {}) =>
  rpc('tools/call', { name, arguments: args }, token)

test('without a token, the tool list includes the tools that need login', async () => {
  const response = await rpc('tools/list', {})
  expect(response.status).toBe(200)
  const names = (await reply(response)).result.tools.map(
    (tool: { name: string }) => tool.name,
  )
  expect(names).toEqual(
    expect.arrayContaining(['phoenix_list_markets', 'whoami', 'call']),
  )
})

test('without a token, a data tool runs in the API under the per-IP limit', async () => {
  const response = await callTool('phoenix_list_markets')
  expect(response.status).toBe(200)
  expect((await reply(response)).result.isError).not.toBe(true)
  expect(api.callPublicTool).toHaveBeenCalledWith('phoenix_list_markets', {})
  expect(env.NO_LOGIN_LIMITER.limit).toHaveBeenCalledWith({
    key: '203.0.113.7',
  })
})

test('without a token, a tool that needs login gets 401 so the client logs in', async () => {
  for (const [name, args] of [
    ['call', {}],
    ['send_feedback', {}],
    ['unknown', {}],
    ['jupiter_swap', { delivery: 'embedded' }],
  ] as const) {
    const response = await callTool(name, undefined, args)
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'resource_metadata=',
    )
  }
  expect(env.NO_LOGIN_LIMITER.limit).not.toHaveBeenCalled()
  expect(api.callPublicTool).not.toHaveBeenCalled()
})

test('past the limit, the agent gets a tool error it can read', async () => {
  noLogin.allowed = false
  const response = await callTool('phoenix_list_markets')
  expect(response.status).toBe(200)
  const { id, result } = await reply(response)
  expect(id).toBe(1)
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain('Too many calls without login')
  expect(api.callPublicTool).not.toHaveBeenCalled()
})

test('listing tools does not count toward the limit', async () => {
  await rpc('tools/list', {})
  expect(env.NO_LOGIN_LIMITER.limit).not.toHaveBeenCalled()
})

test('a request with a token still goes through login checks', async () => {
  const response = await callTool('phoenix_list_markets', 'not-a-real-token')
  expect(response.status).toBe(401)
  expect(api.callPublicTool).not.toHaveBeenCalled()
  expect(env.NO_LOGIN_LIMITER.limit).not.toHaveBeenCalled()
})

test("without a token, a transaction for the agent's own wallet runs under the limit", async () => {
  const response = await callTool('solana_transfer', undefined, {
    recipient: '11111111111111111111111111111111',
    amountLamports: '1',
    delivery: 'local',
    wallet: '11111111111111111111111111111111',
    idempotencyKey: 'transfer-1',
  })
  expect(response.status).toBe(200)
  expect(api.createTransactionRequest).toHaveBeenCalledWith(
    null,
    'solana_transfer',
    expect.objectContaining({ delivery: 'local' }),
  )
  expect(env.NO_LOGIN_LIMITER.limit).toHaveBeenCalledTimes(1)
})
