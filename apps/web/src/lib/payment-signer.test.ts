import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { disablePaymentSigner, enablePaymentSigner } from './payment-signer'

const wallet = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
const grant = { signerId: 'signer-1', policyIds: ['policy-1'] }
const duplicate = new Error(
  'Duplicate signer(s) provided when updating wallet.',
)

const fetchSigner = spyOn(globalThis, 'fetch')
afterAll(() => fetchSigner.mockRestore())
afterEach(() => fetchSigner.mockReset())

/** Answers /prepare with the grant and /confirm with the given response. */
function serve(confirm: () => Response) {
  fetchSigner.mockImplementation(
    Object.assign(
      (input: Parameters<typeof fetch>[0]) =>
        Promise.resolve(
          String(input).endsWith('/prepare') ? Response.json(grant) : confirm(),
        ),
      { preconnect: fetch.preconnect },
    ),
  )
}

const getAccessToken = () => Promise.resolve('token')

test('turning payments on adds the prepared signer, then asks the server to check', async () => {
  serve(() => Response.json({ status: 'enabled', walletAddress: wallet }))
  const added: unknown[] = []
  const status = await enablePaymentSigner(getAccessToken, wallet, (input) => {
    added.push(input)
    return Promise.resolve()
  })
  expect(added).toEqual([{ address: wallet, signers: [grant] }])
  expect(status).toEqual({ status: 'enabled', walletAddress: wallet })
})

test('a signer that is already on the wallet still turns payments on', async () => {
  serve(() => Response.json({ status: 'enabled', walletAddress: wallet }))
  const status = await enablePaymentSigner(getAccessToken, wallet, () =>
    Promise.reject(duplicate),
  )
  expect(status).toEqual({ status: 'enabled', walletAddress: wallet })
})

test("Privy's refusal is reported when the server does not find the signer", async () => {
  serve(() =>
    Response.json({ error: 'Not on this wallet yet' }, { status: 409 }),
  )
  await expect(
    enablePaymentSigner(getAccessToken, wallet, () =>
      Promise.reject(duplicate),
    ),
  ).rejects.toBe(duplicate)
})

test('payment disable sends the owner wallet to server-side selective removal', async () => {
  fetchSigner.mockResolvedValue(
    Response.json({ status: 'disabled', walletAddress: wallet }),
  )
  await expect(disablePaymentSigner(getAccessToken, wallet)).resolves.toEqual({
    status: 'disabled',
    walletAddress: wallet,
  })
  expect(fetchSigner).toHaveBeenCalledWith('/api/payments/signer/disable', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ walletAddress: wallet }),
  })
})

test('a remote removal failure remains an error so the owner can retry', async () => {
  fetchSigner.mockResolvedValue(
    Response.json(
      { error: 'Payments stopped locally; retry signer removal' },
      { status: 502 },
    ),
  )
  await expect(disablePaymentSigner(getAccessToken, wallet)).rejects.toThrow(
    'retry signer removal',
  )
})
