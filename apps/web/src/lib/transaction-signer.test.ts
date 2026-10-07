import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import type { TransactionSignerStatus } from '@lanatools/contracts'
import {
  disableTransactionSigner,
  enableTransactionSigner,
  getTransactionSigner,
} from './transaction-signer'

const wallet = '11111111111111111111111111111111'
const grant = { signerId: 'transaction-only', policyIds: ['sol-only'] }
const enabled = {
  status: 'enabled',
  walletAddress: wallet,
  setupAvailable: true,
} satisfies TransactionSignerStatus
const token = async () => 'owner-token'
const request = spyOn(globalThis, 'fetch')
afterEach(() => request.mockReset())
afterAll(() => request.mockRestore())

test('owner enable prepares, attaches only the transaction grant, then confirms with the server', async () => {
  const order: string[] = []
  request.mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const path = String(input)
        order.push(path)
        return Response.json(path.endsWith('/prepare') ? grant : enabled)
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const result = await enableTransactionSigner(token, wallet, async (input) => {
    expect(input).toEqual({ address: wallet, signers: [grant] })
    order.push('owner-attachment')
  })
  expect(result).toEqual(enabled)
  expect(order).toEqual([
    '/api/transactions/signer/prepare',
    'owner-attachment',
    '/api/transactions/signer/confirm',
  ])
  expect(request.mock.calls[0]?.[1]?.body).toBe(
    JSON.stringify({ walletAddress: wallet }),
  )
  expect(request.mock.calls[1]?.[1]?.body).toBe(
    JSON.stringify({ walletAddress: wallet }),
  )
})

test('default-off setup and malformed grants never ask the owner to attach a signer', async () => {
  let attaches = 0
  for (const response of [
    Response.json({ error: 'Setup unavailable' }, { status: 503 }),
    Response.json({ signerId: 'wrong' }),
  ]) {
    request.mockResolvedValue(response)
    await expect(
      enableTransactionSigner(token, wallet, async () => {
        attaches++
      }),
    ).rejects.toThrow()
  }
  expect(attaches).toBe(0)
})

test('a duplicate attachment is accepted only when server confirmation succeeds', async () => {
  request
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(Response.json(enabled))
  await expect(
    enableTransactionSigner(token, wallet, async () => {
      throw new Error('Duplicate signer')
    }),
  ).resolves.toEqual(enabled)
  const rejected = new Error('Owner rejected attachment')
  request
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(
      Response.json({ error: 'Not attached' }, { status: 409 }),
    )
  await expect(
    enableTransactionSigner(token, wallet, async () => {
      throw rejected
    }),
  ).rejects.toBe(rejected)
})

test('disable delegates selective removal to one authenticated server request', async () => {
  const disabled = {
    ...enabled,
    status: 'disabled',
  } satisfies TransactionSignerStatus
  request.mockResolvedValue(Response.json(disabled))
  expect(await disableTransactionSigner(token, wallet)).toEqual(disabled)
  expect(request).toHaveBeenCalledWith('/api/transactions/signer/disable', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer owner-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ walletAddress: wallet }),
  })
})

test('status is validated and missing owner authentication sends nothing', async () => {
  await expect(getTransactionSigner(async () => null)).rejects.toThrow(
    'Sign in again',
  )
  expect(request).not.toHaveBeenCalled()
  request.mockResolvedValue(
    Response.json({ status: 'enabled', walletAddress: wallet }),
  )
  await expect(getTransactionSigner(token)).rejects.toThrow()
})

test('successful owner attachment does not enable SOL when server confirmation refuses it', async () => {
  request
    .mockResolvedValueOnce(Response.json(grant))
    .mockResolvedValueOnce(
      Response.json(
        { error: 'Transaction policy does not match' },
        { status: 409 },
      ),
    )
  await expect(
    enableTransactionSigner(token, wallet, async () => {}),
  ).rejects.toThrow('Transaction policy does not match')
})

test('SOL removal failure remains retryable without a client-side signer removal call', async () => {
  request.mockResolvedValue(
    Response.json(
      { error: 'SOL stopped locally; retry signer removal' },
      { status: 502 },
    ),
  )
  await expect(disableTransactionSigner(token, wallet)).rejects.toThrow(
    'retry signer removal',
  )
  expect(request).toHaveBeenCalledTimes(1)
})
