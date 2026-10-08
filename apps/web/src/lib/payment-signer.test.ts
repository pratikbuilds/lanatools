import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { attachPaymentSigner, removePaymentSigner } from './payment-signer'

const wallet = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
const grant = { signerId: 'signer-1', policyIds: ['policy-1'] }
const duplicate = new Error(
  'Duplicate signer(s) provided when updating wallet.',
)

const fetchSigner = spyOn(globalThis, 'fetch')
afterAll(() => fetchSigner.mockRestore())
afterEach(() => fetchSigner.mockReset())

/** Answers /prepare with the grant and each /confirm with the next response. */
function serve(...confirms: Array<() => Response>) {
  fetchSigner.mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) =>
        Promise.resolve(
          String(input).endsWith('/prepare')
            ? Response.json(grant)
            : (confirms.shift() ?? notAttached)(),
        ),
      { preconnect: fetch.preconnect },
    ),
  )
}

const enabled = () =>
  Response.json({ status: 'enabled', walletAddress: wallet })
const notAttached = () =>
  Response.json(
    { error: 'Not on this wallet yet', code: 'signer-not-attached' },
    { status: 409 },
  )
const removedMeanwhile = () =>
  Response.json({ error: 'You removed LanaTools access.' }, { status: 409 })

const getAccessToken = () => Promise.resolve('token')

/** Privy's signer calls, recorded in order. */
function privy({ addFails = 0 } = {}) {
  const calls: unknown[] = []
  return {
    calls,
    addSigners: (input: unknown) => {
      calls.push(['add', input])
      return addFails-- > 0 ? Promise.reject(duplicate) : Promise.resolve()
    },
    removeSigners: (input: unknown) => {
      calls.push(['remove', input])
      return Promise.resolve()
    },
  }
}

test('setup adds the prepared signer, then asks the server to check', async () => {
  serve(enabled)
  const signers = privy()
  const status = await attachPaymentSigner(
    getAccessToken,
    wallet,
    false,
    signers,
  )
  expect(signers.calls).toEqual([
    ['add', { address: wallet, signers: [grant] }],
  ])
  expect(status).toEqual({ status: 'enabled', walletAddress: wallet })
})

test('a signer already on the wallet with this policy turns payments on', async () => {
  serve(enabled)
  const signers = privy({ addFails: 1 })
  const status = await attachPaymentSigner(
    getAccessToken,
    wallet,
    false,
    signers,
  )
  expect(signers.calls).toHaveLength(1)
  expect(status).toEqual({ status: 'enabled', walletAddress: wallet })
})

test('a signer left on the wallet with another policy is replaced', async () => {
  serve(notAttached, enabled)
  const signers = privy({ addFails: 1 })
  const status = await attachPaymentSigner(
    getAccessToken,
    wallet,
    false,
    signers,
  )
  expect(signers.calls).toEqual([
    ['add', { address: wallet, signers: [grant] }],
    ['remove', { address: wallet }],
    ['add', { address: wallet, signers: [grant] }],
  ])
  expect(status).toEqual({ status: 'enabled', walletAddress: wallet })
})

test('access removed during setup leaves the wallet alone', async () => {
  serve(removedMeanwhile)
  const signers = privy({ addFails: 1 })
  await expect(
    attachPaymentSigner(getAccessToken, wallet, false, signers),
  ).rejects.toThrow('You removed LanaTools access')
  expect(signers.calls).toEqual([
    ['add', { address: wallet, signers: [grant] }],
  ])
})

test('setup fails when Privy still refuses the signer after replacing it', async () => {
  serve(notAttached)
  await expect(
    attachPaymentSigner(getAccessToken, wallet, false, privy({ addFails: 2 })),
  ).rejects.toBe(duplicate)
})

test('setting up again after a removal tells the server the user asked', async () => {
  serve(enabled)
  await attachPaymentSigner(getAccessToken, wallet, true, privy())
  const [, init] = fetchSigner.mock.calls[0] ?? []
  expect(JSON.parse(String(init?.body))).toEqual({
    walletAddress: wallet,
    restore: true,
  })
})

test('removing access stops payments on the server before Privy is asked', async () => {
  const order: string[] = []
  fetchSigner.mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        order.push(String(input))
        return Promise.resolve(
          Response.json({ status: 'disabled', walletAddress: wallet }),
        )
      },
      { preconnect: fetch.preconnect },
    ),
  )
  const status = await removePaymentSigner(getAccessToken, wallet, () => {
    order.push('privy')
    return Promise.resolve()
  })
  expect(order).toEqual(['/api/payments/signer/disable', 'privy'])
  expect(status.status).toBe('disabled')
})

test('a removal that Privy fails says payments are already stopped', async () => {
  fetchSigner.mockImplementation(
    Object.assign(
      () =>
        Promise.resolve(
          Response.json({ status: 'disabled', walletAddress: wallet }),
        ),
      { preconnect: fetch.preconnect },
    ),
  )
  await expect(
    removePaymentSigner(getAccessToken, wallet, () =>
      Promise.reject(new Error('Wallet proxy not initialized.')),
    ),
  ).rejects.toThrow('Payments are stopped')
})
