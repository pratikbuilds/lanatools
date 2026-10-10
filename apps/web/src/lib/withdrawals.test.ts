import { afterEach, expect, mock, test } from 'bun:test'
import {
  generateKeyPairSigner,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  compileTransaction,
  signTransaction,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  getSignatureFromTransaction,
  blockhash,
} from '@solana/kit'
import {
  formatTokenAmount,
  parseTokenAmount,
  withdrawToken,
} from './withdrawals'

test('amounts are parsed to USDC base units and back', () => {
  expect(parseTokenAmount('1.50')).toBe(1_500_000n)
  expect(parseTokenAmount(' 0.000001 ')).toBe(1n)
  expect(parseTokenAmount('25')).toBe(25_000_000n)
  for (const bad of ['', '0', '0.00', '.5', '1.1234567', '$1', '1,000', 'abc'])
    expect(parseTokenAmount(bad)).toBeNull()

  expect(formatTokenAmount(1_500_000n)).toBe('1.50')
  expect(formatTokenAmount(1n)).toBe('0.000001')
  expect(formatTokenAmount(1_234_000_000n)).toBe('1234.00')
})

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const request = {
  owner: 'owner',
  to: 'to',
  amount: '1500000',
  mint: 'mint',
  source: 'source',
}

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
        calls.length === 1
          ? { transaction: unsigned }
          : { signature: 'sig', confirmed: true },
      )
    },
  ) as unknown as typeof fetch

  const receipt = await withdrawToken(
    () => Promise.resolve('token'),
    request,
    async (bytes) => {
      expect(new TextDecoder().decode(bytes)).toBe('unsigned bytes')
      return new TextEncoder().encode('signed bytes')
    },
  )
  expect(receipt).toEqual({ signature: 'sig', confirmed: true })
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
    withdrawToken(() => Promise.resolve('token'), request, sign),
  ).rejects.toThrow('Not enough USDC in the wallet')
  expect(sign).not.toHaveBeenCalled()

  globalThis.fetch = mock(async () =>
    Response.json({ error: 'Internal server error' }, { status: 502 }),
  ) as unknown as typeof fetch
  await expect(
    withdrawToken(() => Promise.resolve('token'), request, sign),
  ).rejects.toThrow('Could not send the withdrawal')
})

test('token precision covers SOL, indivisible tokens and u64 amounts', () => {
  expect(parseTokenAmount('0.000000001', 9)).toBe(1n)
  expect(parseTokenAmount('2', 0)).toBe(2n)
  expect(parseTokenAmount('2.1', 0)).toBeNull()
  expect(parseTokenAmount('1.234', 2)).toBeNull()
  expect(parseTokenAmount('18446744073709551616', 0)).toBeNull()
  expect(formatTokenAmount(1n, 9)).toBe('0.000000001')
  expect(formatTokenAmount(2n, 0)).toBe('2')
})

test('a lost send response preserves the signature and does not invite another transfer', async () => {
  const signer = await generateKeyPairSigner()
  const message = setTransactionMessageLifetimeUsingBlockhash(
    {
      blockhash: blockhash('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
      lastValidBlockHeight: 100n,
    },
    setTransactionMessageFeePayer(
      signer.address,
      createTransactionMessage({ version: 0 }),
    ),
  )
  const signed = await signTransaction(
    [signer.keyPair],
    compileTransaction(message),
  )
  let calls = 0
  globalThis.fetch = mock(async () => {
    if (++calls === 1)
      return Response.json({
        transaction: getBase64EncodedWireTransaction(signed),
      })
    throw new Error('connection lost')
  }) as unknown as typeof fetch
  const result = await withdrawToken(
    () => Promise.resolve('token'),
    request,
    async () => new Uint8Array(getTransactionEncoder().encode(signed)),
  )
  expect(result).toEqual({
    signature: getSignatureFromTransaction(signed),
    confirmed: false,
  })
  expect(calls).toBe(2)
})
