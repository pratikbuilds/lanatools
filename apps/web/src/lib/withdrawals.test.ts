import { afterEach, expect, mock, test } from 'bun:test'
import { formatUsdcAmount, parseUsdcAmount, withdrawUsdc } from './withdrawals'

test('amounts are parsed to USDC base units and back', () => {
  expect(parseUsdcAmount('1.50')).toBe(1_500_000n)
  expect(parseUsdcAmount(' 0.000001 ')).toBe(1n)
  expect(parseUsdcAmount('25')).toBe(25_000_000n)
  for (const bad of ['', '0', '0.00', '.5', '1.1234567', '$1', '1,000', 'abc'])
    expect(parseUsdcAmount(bad)).toBeNull()

  expect(formatUsdcAmount(1_500_000n)).toBe('1.50')
  expect(formatUsdcAmount(1n)).toBe('0.000001')
  expect(formatUsdcAmount(1_234_000_000n)).toBe('1234.00')
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const request = { owner: 'owner', to: 'to', amount: '1500000' }

test('a withdrawal is prepared, signed here and sent', async () => {
  const unsigned = btoa('unsigned bytes')
  const calls: Array<{ path: string; body: unknown; auth: string | null }> = []
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        path: String(input),
        body: JSON.parse(String(init?.body)),
        auth: headers.get('authorization'),
      })
      return Response.json(
        calls.length === 1 ? { transaction: unsigned } : { signature: 'sig' },
      )
    },
  ) as unknown as typeof fetch

  const receipt = await withdrawUsdc(
    () => Promise.resolve('token'),
    request,
    async (bytes) => {
      expect(new TextDecoder().decode(bytes)).toBe('unsigned bytes')
      return new TextEncoder().encode('signed bytes')
    },
  )
  expect(receipt).toEqual({ signature: 'sig' })
  expect(calls).toEqual([
    {
      path: '/api/wallet/withdrawals/prepare',
      body: request,
      auth: 'Bearer token',
    },
    {
      path: '/api/wallet/withdrawals/send',
      body: { transaction: btoa('signed bytes') },
      auth: 'Bearer token',
    },
  ])
})

test('a refusal is shown in its own words; other failures are generic', async () => {
  globalThis.fetch = mock(async () =>
    Response.json({ error: 'Not enough USDC in the wallet' }, { status: 409 }),
  ) as unknown as typeof fetch
  const sign = mock(async (bytes: Uint8Array) => bytes)
  await expect(
    withdrawUsdc(() => Promise.resolve('token'), request, sign),
  ).rejects.toThrow('Not enough USDC in the wallet')
  expect(sign).not.toHaveBeenCalled()

  globalThis.fetch = mock(async () =>
    Response.json({ error: 'Internal server error' }, { status: 502 }),
  ) as unknown as typeof fetch
  await expect(
    withdrawUsdc(() => Promise.resolve('token'), request, sign),
  ).rejects.toThrow('Could not send the withdrawal')
})
