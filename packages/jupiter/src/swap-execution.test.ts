import { expect, test } from 'bun:test'
import { getBase58Decoder } from '@solana/kit'
import { JupiterClient } from './index'

const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1))
const input = {
  signedTransaction: 'AQID',
  requestId: 'order-1',
  lastValidBlockHeight: '9007199254740993',
}

test('execution sends one authenticated POST and returns an advisory acknowledgement', async () => {
  let calls = 0
  const client = new JupiterClient({
    apiKey: 'test-key',
    fetch: async (url, init) => {
      calls++
      expect(url).toBe('https://api.jup.ag/swap/v2/execute')
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'manual',
        headers: {
          'x-api-key': 'test-key',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return Response.json({
        status: 'Success',
        signature,
        code: 0,
        slot: '123',
        privateProviderField: 'not-exposed',
      })
    },
  })
  const result = await client.executeSwap(input)
  expect(result).toMatchObject({
    ok: true,
    result: {
      source: 'jupiter',
      network: 'mainnet-beta',
      data: { status: 'Success', signature, code: 0 },
      warnings: [expect.stringContaining('advisory')],
    },
  })
  expect(JSON.stringify(result)).not.toContain('not-exposed')
  expect(JSON.stringify(result)).not.toContain('confirmedAt')
  expect(calls).toBe(1)
})

test('execution validates response shape and never exposes provider diagnostics', async () => {
  for (const response of [
    {},
    { status: 'Success' },
    { status: 'Success', signature: 'invalid' },
    { status: 'Unknown', signature },
    { status: 'Failed', signature, code: '0' },
  ]) {
    const result = await new JupiterClient({
      apiKey: 'test-key',
      fetch: async () =>
        Response.json({ ...response, error: 'private-secret' }),
    }).executeSwap(input)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'upstream_unavailable' },
    })
    expect(JSON.stringify(result)).not.toContain('private-secret')
  }
  expect(
    await new JupiterClient({
      apiKey: 'test-key',
      fetch: async () =>
        Response.json({
          status: 'Failed',
          code: -1001,
          error: 'private-secret',
        }),
    }).executeSwap(input),
  ).toMatchObject({
    ok: true,
    result: { data: { status: 'Failed', signature: null, code: -1001 } },
  })
})

test('execution does not retry HTTP failures, redirects, or malformed JSON', async () => {
  for (const status of [302, 400, 429, 500, 200]) {
    let calls = 0
    const result = await new JupiterClient({
      apiKey: 'test-key',
      fetch: async () => {
        calls++
        return new Response('private-secret', {
          status,
          headers: { 'Retry-After': '0' },
        })
      },
    }).executeSwap(input)
    expect(result).toMatchObject({ ok: false })
    expect(JSON.stringify(result)).not.toContain('private-secret')
    expect(calls).toBe(1)
  }
})

test('execution timeout and transport failure remain uncertain and never retry', async () => {
  for (const timeout of [true, false]) {
    let calls = 0
    const result = await new JupiterClient({
      apiKey: 'test-key',
      requestTimeoutMs: 5,
      fetch: async (_url, init) => {
        calls++
        if (!timeout) throw new Error('private-secret')
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error('private-secret')),
            { once: true },
          )
        })
      },
    }).executeSwap(input)
    expect(result).toMatchObject({
      ok: false,
      error: { retryable: true, message: expect.stringContaining('reconcile') },
    })
    expect(JSON.stringify(result)).not.toContain('private-secret')
    expect(calls).toBe(1)
  }
})

test('execution rejects invalid requests or missing configuration before making a request', async () => {
  let calls = 0
  const fetch = async () => {
    calls++
    return Response.json({})
  }
  const client = new JupiterClient({ apiKey: 'test-key', fetch })
  for (const invalid of [
    { ...input, signedTransaction: '' },
    { ...input, signedTransaction: 'private-secret' },
    { ...input, requestId: ' ' },
    { ...input, lastValidBlockHeight: '-1' },
    { ...input, network: 'devnet' },
  ])
    expect(await client.executeSwap(invalid)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  expect(
    await new JupiterClient({ apiKey: '', fetch }).executeSwap(input),
  ).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' } })
  expect(calls).toBe(0)
})
