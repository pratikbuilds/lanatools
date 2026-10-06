import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import {
  address,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import type { ExternalTransferReview } from '@lanatools/contracts'
import { defaultSolanaRpcsPlugin } from '@privy-io/react-auth/solana'
import {
  callTransferLink,
  exactSOL,
  signedWireForSubmit,
  tokenFromFragment,
  transferStatus,
} from './external-transfer'

const request = spyOn(globalThis, 'fetch')
afterAll(() => request.mockRestore())
afterEach(() => request.mockReset())
const token = 'ab'.repeat(32)
const review: ExternalTransferReview = {
  requestId: 'request',
  state: 'requested',
  recipient: '11111111111111111111111111111111',
  amountLamports: '1000000001',
  walletAddress: null,
  network: 'devnet',
  expiresAt: 1_900_000_000_000,
  transactionBase64: null,
  signature: null,
  reason: null,
  commitment: null,
  transactionExpired: false,
}

test('Privy Solana RPC defaults supply separate working devnet and mainnet clients', async () => {
  const clients = defaultSolanaRpcsPlugin().getDefaultRpcs({
    appId: 'mock-app',
  })
  const urls: string[] = []
  request.mockImplementation(
    Object.assign(
      async (...[url, init]: Parameters<typeof fetch>) => {
        urls.push(String(url))
        const body: unknown = JSON.parse(String(init?.body))
        if (!body || typeof body !== 'object' || !('id' in body))
          throw new Error('Missing JSON RPC request')
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: '11111111111111111111111111111111',
        })
      },
      { preconnect: () => {} },
    ),
  )
  for (const chain of ['solana:devnet', 'solana:mainnet'] as const) {
    const client = clients[chain]
    if (!client) throw new Error(`Missing RPC configuration for ${chain}`)
    expect(String(await client.rpc.getGenesisHash().send())).toBe(
      '11111111111111111111111111111111',
    )
  }
  expect(urls).toEqual([
    'https://solana-devnet.rpc.privy.systems?privyAppId=mock-app',
    'https://solana-mainnet.rpc.privy.systems?privyAppId=mock-app',
  ])
})

test('capability is read only from a valid token fragment', () => {
  expect(tokenFromFragment(`#token=${token}`)).toBe(token)
  expect(tokenFromFragment('')).toBeNull()
  expect(tokenFromFragment('#token=wrong')).toBeNull()
  expect(tokenFromFragment(`#${token}`)).toBeNull()
})

test('link requests never put the capability into a path, query, cookie or referrer', async () => {
  request.mockResolvedValue(Response.json(review))
  await callTransferLink(token, 'prepare', { walletAddress: 'source' })
  expect(request).toHaveBeenCalledWith('/api/transactions/link/prepare', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ walletAddress: 'source' }),
  })
  request.mockResolvedValue(Response.json(review))
  await callTransferLink(token, 'review')
  expect(request.mock.calls[1]?.[0]).toBe('/api/transactions/link')
  expect(request.mock.calls[1]?.[1]?.body).toBeUndefined()
})

test('malformed reviews, wrong networks and server denial fail closed', async () => {
  for (const payload of [{}, { ...review, network: 'mainnet' }]) {
    request.mockResolvedValue(Response.json(payload))
    await expect(callTransferLink(token, 'review')).rejects.toThrow()
  }
  request.mockResolvedValue(
    Response.json({ error: 'Link expired' }, { status: 403 }),
  )
  await expect(callTransferLink(token, 'review')).rejects.toThrow(
    'Link expired',
  )
})

test('SOL amounts retain every lamport without floating point rounding', () => {
  expect(exactSOL('1')).toBe('0.000000001')
  expect(exactSOL('1000000001')).toBe('1.000000001')
  expect(exactSOL('18446744073709551615')).toBe('18446744073.709551615')
})

test('the wallet may add signatures but cannot replace reviewed message bytes', () => {
  const wallet = '11111111111111111111111111111111'
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayer(address(wallet), message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash(wallet), lastValidBlockHeight: 100n },
          message,
        ),
    ),
  )
  const unsigned = new Uint8Array(getTransactionEncoder().encode(transaction))
  const encoded = getBase64Decoder().decode(unsigned)
  const signed = unsigned.slice()
  signed.fill(1, 1, 65)
  expect(signedWireForSubmit(encoded, signed)).toBe(
    getBase64Decoder().decode(signed),
  )
  const changed = signed.slice()
  changed[changed.length - 1] = 1
  expect(() => signedWireForSubmit(encoded, changed)).toThrow()
})

test('submitted, confirmed, finalized, failed, expired and unknown outcomes are distinct', () => {
  expect(transferStatus(review)).toBe('Awaiting your approval')
  expect(transferStatus({ ...review, state: 'submitted' })).toContain(
    'Submitted',
  )
  expect(
    transferStatus({ ...review, state: 'succeeded', commitment: 'confirmed' }),
  ).toBe('Confirmed')
  expect(
    transferStatus({ ...review, state: 'succeeded', commitment: 'finalized' }),
  ).toBe('Finalized')
  expect(transferStatus({ ...review, state: 'failed' })).toBe('Failed')
  expect(transferStatus({ ...review, state: 'expired' })).toBe('Expired')
  expect(transferStatus({ ...review, state: 'uncertain' })).toContain(
    'Unknown outcome',
  )
  expect(transferStatus({ ...review, transactionExpired: true })).toContain(
    'outcome may still be unknown',
  )
})
