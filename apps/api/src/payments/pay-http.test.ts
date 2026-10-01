import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { PermissionDeniedError } from '@solana/pay-kit/client'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { mcpGrant, paymentActivity, paymentSigner } from '../db/schema'
import { listClients } from '../mcp-grants'
import { testDatabase } from '../test-database'
import { PayHttpError, payHttp } from './pay-http'
import type { Payer, PayHttpDeps, PayHttpInput } from './pay-http'
import type { PaymentNetwork } from './network'
import { PolicyDeniedError } from './privy-signer'

const DEVNET: PaymentNetwork = {
  name: 'devnet',
  caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
}
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const MERCHANT = 'Du3X3wKN3LHfSbXtX2PW5jhnSHit8j8NSb19VZW6V9mu'
const WALLET = 'CLmnd3o7hd4oCpiL9Wb3mC4nnJJAHdV7AjpwmbKrejAW'
const SIGNATURE = '5'.repeat(87)
const URL_FIXED = 'https://merchant.example/api/v1/fixed'

let db: D1Database
let dispose: () => Promise<void>
beforeAll(async () => {
  ;({ db, dispose } = await testDatabase())
}, 60_000)
afterAll(() => dispose())

let user: string
beforeEach(() => {
  user = `user-${crypto.randomUUID()}`
})

async function connectClient(
  limitMicroUsd: number,
  { clientId = 'client-a', scope = 'account:read payments:pay' } = {},
) {
  const grantId = crypto.randomUUID()
  await drizzle(db).insert(mcpGrant).values({
    id: grantId,
    privyUserId: user,
    clientId,
    status: 'active',
    scope,
    limitMicroUsd,
    createdAt: Date.now(),
  })
  return { grantId, userId: user, clientId }
}

async function enableSigner(status: 'enabled' | 'disabled' = 'enabled') {
  await drizzle(db)
    .insert(paymentSigner)
    .values({
      privyUserId: user,
      walletId: 'wallet-1',
      walletAddress: WALLET,
      policyId: 'policy-1',
      status,
      updatedAt: Date.now(),
    })
    .onConflictDoUpdate({ target: paymentSigner.privyUserId, set: { status } })
}

function base64url(value: unknown) {
  return btoa(JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function mpp402({
  amount = '10000',
  currency = DEVNET.usdcMint,
  network = 'devnet',
} = {}) {
  const request = base64url({
    amount,
    currency,
    recipient: MERCHANT,
    methodDetails: {
      decimals: 6,
      network,
      feePayer: true,
      feePayerKey: MERCHANT,
    },
  })
  return new Response('{"error":"payment_required"}', {
    status: 402,
    headers: {
      'www-authenticate': `Payment id="abc", realm="test", method="solana", intent="charge", request="${request}", expires="${new Date(Date.now() + 60_000).toISOString()}"`,
    },
  })
}

function x402Response({
  network = DEVNET.caip2,
  asset = DEVNET.usdcMint,
} = {}) {
  const required = btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        { scheme: 'exact', network, amount: '10000', asset, payTo: MERCHANT },
      ],
    }),
  )
  return new Response('', {
    status: 402,
    headers: { 'payment-required': required },
  })
}

/** Acts like Pay Kit: reports the challenge, signs, then pays. */
function fakePayer(
  respond: () => Promise<Response> | Response = () =>
    new Response('{"status":"ok"}', {
      headers: { 'payment-response': SIGNATURE },
    }),
  challenge = {
    amount: '10000',
    currency: DEVNET.usdcMint,
    recipient: MERCHANT,
  },
): Payer {
  return async ({ onProgress }) => {
    onProgress({ type: 'challenge', ...challenge })
    onProgress({ type: 'signing' })
    return respond()
  }
}

function deps(overrides: Partial<PayHttpDeps> = {}): PayHttpDeps {
  return {
    db,
    config: async () => ({ network: DEVNET, rpcUrl: 'https://rpc.invalid' }),
    payer: () => fakePayer(),
    fetch: mock(async () => x402Response()) as unknown as typeof fetch,
    verify: async () => ({ status: 'paid' }),
    ...overrides,
  }
}

const input = (overrides: Partial<PayHttpInput> = {}): PayHttpInput => ({
  url: URL_FIXED,
  method: 'GET',
  protocol: 'auto',
  maxUsd: '0.05',
  ...overrides,
})

async function activity() {
  return drizzle(db)
    .select()
    .from(paymentActivity)
    .where(eq(paymentActivity.privyUserId, user))
}

async function totals(clientId = 'client-a') {
  const client = (await listClients(db, user)).find(
    (c) => c.clientId === clientId,
  )
  return { spent: client?.spentMicroUsd, reserved: client?.reservedMicroUsd }
}

test('a free endpoint is returned unpaid and recorded', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const payer = mock(() => fakePayer())
  const result = await payHttp(
    deps({
      payer,
      fetch: (async () =>
        new Response('hello', { status: 200 })) as unknown as typeof fetch,
    }),
    grant,
    input(),
  )
  expect(result).toMatchObject({ status: 200, body: 'hello', payment: null })
  expect(payer).not.toHaveBeenCalled()
  expect((await activity()).map((a) => a.status)).toEqual(['free'])
})

test('a fixed x402 charge is reserved, paid, and settled as spend', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const result = await payHttp(deps(), grant, input({ protocol: 'x402' }))
  expect(result.payment).toEqual({
    state: 'paid',
    protocol: 'x402',
    network: 'devnet',
    mint: DEVNET.usdcMint,
    amountAtomic: '10000',
    signature: SIGNATURE,
  })
  expect(await totals()).toEqual({ spent: 10_000, reserved: 0 })
  const [row] = await activity()
  expect(row).toMatchObject({
    status: 'paid',
    origin: 'https://merchant.example',
    path: '/api/v1/fixed',
    settledAtomic: 10_000,
    signature: SIGNATURE,
  })
})

test('an MPP charge settles from its Payment-Receipt reference', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const receipt = btoa(
    JSON.stringify({
      method: 'solana',
      reference: SIGNATURE,
      status: 'success',
      timestamp: new Date().toISOString(),
    }),
  )
  const result = await payHttp(
    deps({
      fetch: (async () => mpp402()) as unknown as typeof fetch,
      payer: () =>
        fakePayer(
          () => new Response('ok', { headers: { 'payment-receipt': receipt } }),
        ),
    }),
    grant,
    input({ protocol: 'mpp' }),
  )
  expect(result.payment).toMatchObject({
    state: 'paid',
    protocol: 'mpp',
    signature: SIGNATURE,
  })
})

test.each([
  [
    'sandbox network',
    () => mpp402({ network: 'localnet', currency: MAINNET_USDC }),
    'mpp',
    'is for localnet',
  ],
  [
    'mainnet x402',
    () =>
      x402Response({
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        asset: MAINNET_USDC,
      }),
    'x402',
    'is for solana:5eykt',
  ],
  [
    'another token',
    () => mpp402({ currency: MAINNET_USDC }),
    'mpp',
    'not in devnet USDC',
  ],
  ['a missing protocol', () => x402Response(), 'mpp', 'does not offer mpp'],
] as const)(
  'refuses %s without signing',
  async (_, respond, protocol, message) => {
    const grant = await connectClient(50_000)
    await enableSigner()
    const payer = mock(() => fakePayer())
    await expect(
      payHttp(
        deps({
          payer,
          fetch: (async () => respond()) as unknown as typeof fetch,
        }),
        grant,
        input({ protocol }),
      ),
    ).rejects.toThrow(message)
    expect(payer).not.toHaveBeenCalled()
    expect((await activity()).map((a) => a.status)).toEqual(['refused'])
    expect(await totals()).toEqual({ spent: 0, reserved: 0 })
  },
)

test('refuses a charge above max_usd', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const payer = mock(() => fakePayer())
  await expect(
    payHttp(deps({ payer }), grant, input({ maxUsd: '0.009' })),
  ).rejects.toThrow('exceeds max_usd')
  expect(payer).not.toHaveBeenCalled()
})

test('refuses a charge above the client limit', async () => {
  const grant = await connectClient(9_999)
  await enableSigner()
  const payer = mock(() => fakePayer())
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'remaining limit of 9999',
  )
  expect(payer).not.toHaveBeenCalled()
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test.each([
  ['http://merchant.example/x', 'https'],
  ['https://user:pw@merchant.example/x', 'credentials'],
  ['https://127.0.0.1/x', 'private'],
  ['https://10.1.2.3/x', 'private'],
  ['https://169.254.169.254/latest', 'private'],
  ['https://[::1]/x', 'private'],
  ['https://localhost/x', 'private'],
  ['https://merchant.example:8443/x', 'default port'],
])('refuses %s before any request', async (url, message) => {
  const grant = await connectClient(50_000)
  const fetcher = mock(async () => x402Response())
  await expect(
    payHttp(
      deps({ fetch: fetcher as unknown as typeof fetch }),
      grant,
      input({ url }),
    ),
  ).rejects.toThrow(message)
  expect(fetcher).not.toHaveBeenCalled()
})

test('refuses headers outside the allowlist', async () => {
  const grant = await connectClient(50_000)
  await expect(
    payHttp(
      deps(),
      grant,
      input({ headers: { Authorization: 'Bearer lana' } }),
    ),
  ).rejects.toThrow('Header Authorization is not allowed')
})

test('a Privy policy denial releases the reservation', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const payer: Payer = async ({ onProgress }) => {
    onProgress({
      type: 'challenge',
      amount: '10000',
      currency: DEVNET.usdcMint,
      recipient: MERCHANT,
    })
    onProgress({ type: 'signing' })
    throw new Error('signing failed', {
      cause: new PolicyDeniedError('denied'),
    })
  }
  await expect(
    payHttp(deps({ payer: () => payer }), grant, input()),
  ).rejects.toThrow('wallet policy refused')
  expect((await activity()).map((a) => a.status)).toEqual(['released'])
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test('a Pay Kit permission denial releases the reservation', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const payer: Payer = async () => {
    throw new PermissionDeniedError([
      { code: 'amount_exceeds_limit', message: 'too much' },
    ])
  }
  await expect(
    payHttp(deps({ payer: () => payer }), grant, input()),
  ).rejects.toThrow('too much')
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test('a charge that changes before payment is refused unsigned', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  let signed = false
  const payer: Payer = async ({ onProgress }) => {
    onProgress({
      type: 'challenge',
      amount: '10000',
      currency: DEVNET.usdcMint,
      recipient: 'Attacker1111111111111111111111111111111111',
    })
    signed = true
    return new Response('')
  }
  await expect(
    payHttp(deps({ payer: () => payer }), grant, input()),
  ).rejects.toThrow('payment request changed')
  expect(signed).toBe(false)
  expect((await activity()).map((a) => a.status)).toEqual(['released'])
})

test('a lost response after signing stays reserved and is never repeated', async () => {
  const grant = await connectClient(15_000)
  await enableSigner()
  const payer = mock(() =>
    fakePayer(() => {
      throw new TypeError('Network connection lost')
    }),
  )
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'will not be retried',
  )
  expect(payer).toHaveBeenCalledTimes(1)
  expect((await activity()).map((a) => a.status)).toEqual(['uncertain'])
  expect(await totals()).toEqual({ spent: 0, reserved: 10_000 })
  // The held reservation still counts: a second charge would overspend.
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'remaining limit of 5000',
  )
  expect(payer).toHaveBeenCalledTimes(1)
})

test('a paid response without a verifiable receipt stays uncertain', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const result = await payHttp(
    deps({ payer: () => fakePayer(() => new Response('ok')) }),
    grant,
    input(),
  )
  expect(result.payment).toMatchObject({ state: 'uncertain', signature: null })
  expect(result.payment?.note).toContain('do not repeat')
  expect(await totals()).toEqual({ spent: 0, reserved: 10_000 })

  const unverified = await payHttp(
    deps({
      verify: async () => ({
        status: 'unconfirmed',
        reason: 'The transaction did not finalize in time',
      }),
    }),
    grant,
    input(),
  )
  expect(unverified.payment).toMatchObject({
    state: 'uncertain',
    signature: SIGNATURE,
  })
  expect(await totals()).toEqual({ spent: 0, reserved: 20_000 })
})

test('concurrent calls cannot reserve more than the remaining limit', async () => {
  const grant = await connectClient(35_000)
  await enableSigner()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const payer = mock(() =>
    fakePayer(async () => {
      await gate
      return new Response('ok', { headers: { 'payment-response': SIGNATURE } })
    }),
  )
  const calls = Array.from({ length: 10 }, () =>
    payHttp(deps({ payer }), grant, input()).then(
      () => 'paid',
      (error: unknown) =>
        error instanceof PayHttpError ? error.message : String(error),
    ),
  )
  // Let every call reach its reservation before any payment finishes.
  await new Promise((resolve) => setTimeout(resolve, 200))
  release()
  const outcomes = await Promise.all(calls)
  expect(outcomes.filter((o) => o === 'paid')).toHaveLength(3)
  expect(payer).toHaveBeenCalledTimes(3)
  expect(await totals()).toEqual({ spent: 30_000, reserved: 0 })
})

test('each client spends only against its own limit', async () => {
  const a = await connectClient(10_000, { clientId: 'client-a' })
  const b = await connectClient(50_000, { clientId: 'client-b' })
  await enableSigner()
  await payHttp(deps(), a, input())
  await expect(payHttp(deps(), a, input())).rejects.toThrow(
    'remaining limit of 0',
  )
  await payHttp(deps(), b, input())
  expect(await totals('client-a')).toEqual({ spent: 10_000, reserved: 0 })
  expect(await totals('client-b')).toEqual({ spent: 10_000, reserved: 0 })
})

test('turning payments off or revoking the client blocks the next call', async () => {
  const grant = await connectClient(50_000)
  const payer = mock(() => fakePayer())
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'Payments are turned off',
  )
  await enableSigner('disabled')
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'Payments are turned off',
  )
  await enableSigner('enabled')
  await payHttp(deps({ payer }), grant, input())
  await drizzle(db)
    .update(mcpGrant)
    .set({ status: 'revoked' })
    .where(eq(mcpGrant.id, grant.grantId))
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'revoked',
  )
  expect(payer).toHaveBeenCalledTimes(1)
})

test('a client without the payments scope cannot reserve', async () => {
  const grant = await connectClient(50_000, { scope: 'account:read' })
  await enableSigner()
  await expect(payHttp(deps(), grant, input())).rejects.toThrow(
    'not allowed to make payments',
  )
})
