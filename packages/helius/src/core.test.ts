import { describe, expect, test } from 'bun:test'
import { runHeliusTool } from './index'
import { createHeliusClient } from './client'
import { transactionSummary } from './transactions'
import { blockTimeToIso, decimalAmount, lamportsToSol } from './format'

const address = '11111111111111111111111111111111'
const signature = '1'.repeat(64)
const rpcUrl = 'https://devnet.helius-rpc.com/?api-key=TEST_SECRET'
function rpcFetch(
  handler: (body: { method: string; params: unknown[] }) => unknown,
  status = 200,
): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) =>
    new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'lanatools',
        result: handler(JSON.parse(String(init?.body))),
      }),
      { status },
    )) as typeof fetch
}
describe('Helius boundary', () => {
  test('rejects malformed addresses, signatures, unsupported tool and agent network before fetching', async () => {
    let calls = 0
    const options = {
      rpcUrl,
      fetch: rpcFetch(() => {
        calls++
        return null
      }),
    }
    for (const [name, input] of [
      ['missing', {}],
      ['get_accounts', { addresses: ['bad'] }],
      ['get_accounts', { addresses: [address], network: 'mainnet' }],
      ['get_transactions', { signatures: ['bad'] }],
    ]) {
      expect(await runHeliusTool(String(name), input, options)).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
        credits: 0,
      })
    }
    expect(calls).toBe(0)
  })
  test('maps HTTP errors safely without leaking upstream bodies or keys', async () => {
    for (const [status, code] of [
      [429, 'rate_limited'],
      [403, 'plan_required'],
      [500, 'upstream_error'],
    ] as const) {
      const outcome = await runHeliusTool(
        'get_accounts',
        { addresses: [address] },
        { rpcUrl, fetch: rpcFetch(() => rpcUrl, status) },
      )
      expect(outcome).toMatchObject({ ok: false, error: { code }, credits: 0 })
      expect(JSON.stringify(outcome)).not.toContain('TEST_SECRET')
    }
  })
  test('redacts nested echoed secrets on success and exceptions on failure', async () => {
    const client = createHeliusClient({ rpcUrl })
    expect(client.redact({ a: [rpcUrl, 'TEST_SECRET'] })).toEqual({
      a: ['[redacted]', '[redacted]'],
    })
    const fail = (async () => {
      throw new Error(rpcUrl)
    }) as unknown as typeof fetch
    const result = await runHeliusTool(
      'get_accounts',
      { addresses: [address] },
      { rpcUrl, fetch: fail },
    )
    expect(JSON.stringify(result)).not.toContain('TEST_SECRET')
  })
  test('maps timeout and malformed JSON to safe codes', async () => {
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      // Abort before the real 10 second deadline to assert the transport path offline.
      Object.defineProperty(init?.signal, 'aborted', { value: true })
      throw new DOMException('secret URL', 'TimeoutError')
    }) as unknown as typeof fetch
    expect(
      await runHeliusTool(
        'get_accounts',
        { addresses: [address] },
        { rpcUrl, fetch: fetcher },
      ),
    ).toMatchObject({ error: { code: 'timeout' } })
    const broken = (async () =>
      new Response('not json TEST_SECRET')) as unknown as typeof fetch
    expect(
      await runHeliusTool(
        'get_accounts',
        { addresses: [address] },
        { rpcUrl, fetch: broken },
      ),
    ).toMatchObject({ error: { code: 'upstream_error' } })
  })
  test('lossless formatting preserves u64-sized amounts', () => {
    expect(decimalAmount(18446744073709551615n, 6)).toBe(
      '18446744073709.551615',
    )
    expect(lamportsToSol(-1000000001n)).toBe('-1.000000001')
    expect(decimalAmount(1000000n, 6)).toBe('1')
    expect(blockTimeToIso(0n)).toBe('1970-01-01T00:00:00.000Z')
    expect(blockTimeToIso(null)).toBeNull()
  })
})

test('accounts shapes wallet, mint, token account, program, unknown and missing without raw bytes', async () => {
  const common = {
    lamports: 1000000001,
    owner: address,
    executable: false,
    rentEpoch: 0,
    space: 0,
  }
  const values = [
    { ...common, data: ['', 'base64'] },
    {
      ...common,
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: {
        program: 'spl-token',
        parsed: { type: 'mint', info: { decimals: 6 } },
        space: 82,
      },
    },
    {
      ...common,
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: {
        program: 'spl-token',
        parsed: {
          type: 'account',
          info: { tokenAmount: { amount: '1000', decimals: 6 } },
        },
        space: 165,
      },
    },
    { ...common, executable: true, data: ['U0VDUkVU', 'base64'], space: 6 },
    {
      ...common,
      owner: 'Vote111111111111111111111111111111111111111',
      data: ['U0VDUkVU', 'base64'],
      space: 6,
    },
    null,
  ]
  let method = ''
  const out = await runHeliusTool(
    'get_accounts',
    { addresses: Array(6).fill(address) },
    {
      rpcUrl,
      fetch: rpcFetch((body) => {
        method = body.method
        return { context: { slot: 42 }, value: values }
      }),
    },
  )
  expect(method).toBe('getMultipleAccounts')
  expect(out).toMatchObject({ ok: true, credits: 1 })
  if (!out.ok) throw new Error(out.error.message)
  const accounts = out.result.accounts as Record<string, unknown>[]
  expect(accounts.map((item) => item.kind)).toEqual([
    'wallet',
    'mint',
    'token_account',
    'program',
    'other',
    null,
  ])
  expect(accounts[0]?.sol_balance).toBe('1.000000001')
  expect(accounts[5]?.exists).toBe(false)
  expect(JSON.stringify(out)).not.toContain('U0VDUkVU')
})

test('transactions preserve success, execution failure and missing with exact credits', async () => {
  let request = 0
  const fetcher = rpcFetch(({ method, params }) => {
    if (method === 'getSignatureStatuses')
      return {
        context: { slot: 10 },
        value: Array(3).fill({
          slot: 10,
          confirmations: null,
          err: null,
          confirmationStatus: 'finalized',
        }),
      }
    expect(method).toBe('getTransaction')
    expect(params[1]).toMatchObject({
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
    })
    request++
    if (request === 3) return null
    return {
      slot: 10,
      blockTime: 1700000000,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [{ pubkey: address, signer: true }],
          instructions: [
            {
              programId: address,
              parsed: {
                type: 'transfer',
                info: {
                  source: address,
                  destination: address,
                  lamports: 1000000000,
                },
              },
            },
          ],
        },
      },
      meta: {
        fee: 5000,
        err:
          request === 2 ? { InstructionError: [0, 'InvalidArgument'] } : null,
      },
    }
  })
  const out = await runHeliusTool(
    'get_transactions',
    { signatures: [signature, signature, signature], detail: 'full' },
    { rpcUrl, fetch: fetcher },
  )
  expect(out).toMatchObject({ ok: true, credits: 4 })
  if (!out.ok) throw new Error(out.error.message)
  const tx = out.result.transactions as Record<string, unknown>[]
  expect(tx[0]).toMatchObject({
    found: true,
    status: 'succeeded',
    fee_sol: '0.000005',
    type: null,
    description: null,
    commitment: 'finalized',
  })
  expect(tx[1]).toMatchObject({ status: 'failed' })
  expect(tx[2]).toEqual({ signature, found: false })
})

test('missing transaction metadata does not invent execution success', () => {
  const tx = {
    slot: 1,
    meta: null,
    transaction: { message: { accountKeys: [address], instructions: [] } },
  }
  const failure = { InstructionError: [0, 'InvalidArgument'] }
  expect(
    transactionSummary(
      signature,
      tx,
      { err: failure, confirmationStatus: 'finalized' },
      false,
    ),
  ).toMatchObject({ status: 'failed', error: failure })
  expect(transactionSummary(signature, tx, null, false)).toMatchObject({
    status: 'unknown',
    error: null,
  })
})

test('a failed transaction batch retains successful request credits without retrying', async () => {
  let calls = 0
  const fetcher = (async (url, init) => {
    calls++
    if (calls === 3)
      return Response.json({ error: { code: -32429, message: rpcUrl } })
    return rpcFetch(({ method }) =>
      method === 'getSignatureStatuses'
        ? { context: { slot: 10 }, value: [null, null] }
        : null,
    )(url, init)
  }) as typeof fetch
  const outcome = await runHeliusTool(
    'get_transactions',
    { signatures: [signature, signature] },
    { rpcUrl, fetch: fetcher },
  )
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: 'rate_limited' },
    credits: 2,
  })
  expect(calls).toBe(3)
  expect(JSON.stringify(outcome)).not.toContain('TEST_SECRET')
})

test('malformed provider data is an upstream error, never invented account or transaction facts', async () => {
  expect(
    await runHeliusTool(
      'get_accounts',
      { addresses: [address] },
      { rpcUrl, fetch: rpcFetch(() => ({ context: { slot: 1 }, value: [] })) },
    ),
  ).toMatchObject({ ok: false, error: { code: 'upstream_error' } })
  expect(
    await runHeliusTool(
      'get_transactions',
      { signatures: [signature] },
      {
        rpcUrl,
        fetch: rpcFetch(({ method }) =>
          method === 'getSignatureStatuses'
            ? { context: { slot: 1 }, value: [null] }
            : 'unexpected provider result',
        ),
      },
    ),
  ).toMatchObject({ ok: false, error: { code: 'upstream_error' } })
})
