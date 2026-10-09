import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import type { D1Database } from '@cloudflare/workers-types'
import { PermissionDeniedError } from '@solana/pay-kit/client'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { mcpGrant, paymentActivity, paymentSigner } from '../db/schema'
import { listClients } from '../mcp-grants'
import { recordSigning, reserve } from './ledger'
import { testDatabase } from '../test-database'
import { PayHttpError, payHttp } from './pay-http'
import type { Payer, PayHttpDeps, PayHttpInput } from './pay-http'
import type { PaymentNetwork } from '../solana/network'
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
const PAYER_SIGNATURE = '4'.repeat(87)
const BLOCKHASH = '3'.repeat(44)
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
  return async ({ onProgress, onSigned }) => {
    onProgress({ type: 'challenge', ...challenge })
    onProgress({ type: 'signing' })
    await onSigned(PAYER_SIGNATURE, BLOCKHASH)
    return respond()
  }
}

function deps(overrides: Partial<PayHttpDeps> = {}): PayHttpDeps {
  return {
    db,
    config: async () => ({ network: DEVNET, rpcUrl: 'https://rpc.invalid' }),
    payer: () => fakePayer(),
    fetch: mock(async () => x402Response()) as unknown as typeof fetch,
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
  expect(result).toMatchObject({
    status: 200,
    body: 'hello',
    bodyEncoding: 'text',
    payment: null,
  })
  expect(payer).not.toHaveBeenCalled()
  expect((await activity()).map((a) => a.status)).toEqual(['free'])
})

test('a large binary response comes back whole as base64', async () => {
  const grant = await connectClient(50_000)
  const image = new Uint8Array(200_000).fill(0xff)
  const result = await payHttp(
    deps({
      fetch: (async () => new Response(image)) as unknown as typeof fetch,
    }),
    grant,
    input(),
  )
  expect(result.bodyEncoding).toBe('base64')
  expect(Buffer.from(result.body, 'base64')).toEqual(Buffer.from(image))
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
  ).rejects.toThrow('This call costs $0.01, more than its max_usd of $0.009')
  expect(payer).not.toHaveBeenCalled()
})

test('refuses a charge above the client limit', async () => {
  const grant = await connectClient(9_999)
  await enableSigner()
  const payer = mock(() => fakePayer())
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'remaining limit of $0.009999',
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

test('a Privy policy denial fails the call and frees its reservation', async () => {
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
  expect((await activity()).map((a) => a.status)).toEqual(['failed'])
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test('a Pay Kit permission denial frees the reservation', async () => {
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
  expect((await activity()).map((a) => a.status)).toEqual(['failed'])
})

test('a lost response after signing fails and says the wallet may be charged', async () => {
  const grant = await connectClient(15_000)
  await enableSigner()
  const payer = mock(() =>
    fakePayer(() => {
      throw new TypeError('Network connection lost')
    }),
  )
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'may have charged the wallet',
  )
  const [row] = await activity()
  expect(row).toMatchObject({
    status: 'failed',
    payerSignature: PAYER_SIGNATURE,
  })
  expect(row?.error).toContain('Network connection lost')
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test('a served call without a receipt is paid', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const result = await payHttp(
    deps({ payer: () => fakePayer(() => new Response('ok')) }),
    grant,
    input(),
  )
  expect(result).toMatchObject({
    status: 200,
    body: 'ok',
    payment: { state: 'paid', signature: null },
  })
  expect(await totals()).toEqual({ spent: 10_000, reserved: 0 })
  const [row] = await activity()
  expect(row).toMatchObject({ status: 'paid', payerSignature: PAYER_SIGNATURE })
})

test("a 402 after signing fails with the endpoint's reason", async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const required = btoa(
    JSON.stringify({ x402Version: 2, error: 'settlement_failed', accepts: [] }),
  )
  const payer = () =>
    fakePayer(
      () =>
        new Response('{}', {
          status: 402,
          headers: { 'payment-required': required, 'x-request-id': 'req-1' },
        }),
    )
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'The endpoint answered 402 after the payment was signed: settlement_failed. The call is not counted against your limit. Its request ID is req-1.',
  )
  expect(await activity()).toMatchObject([
    { status: 'failed', httpStatus: 402 },
  ])
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test('any other error answer after signing fails the call', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const payer = () =>
    fakePayer(() => new Response('upstream down', { status: 503 }))
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'The endpoint answered 503 after the payment was signed. The call is not counted against your limit.',
  )
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
})

test('an endpoint that stops asking for payment is served free', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const payer: Payer = async () => new Response('served')
  const result = await payHttp(deps({ payer: () => payer }), grant, input())
  expect(result).toMatchObject({ status: 200, body: 'served', payment: null })
  expect((await activity()).map((a) => a.status)).toEqual(['free'])
  expect(await totals()).toEqual({ spent: 0, reserved: 0 })
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
    'remaining limit of $0.00',
  )
  await payHttp(deps(), b, input())
  expect(await totals('client-a')).toEqual({ spent: 10_000, reserved: 0 })
  expect(await totals('client-b')).toEqual({ spent: 10_000, reserved: 0 })
})

test('payments that are not set up or a revoked client block the next call', async () => {
  const grant = await connectClient(50_000)
  const payer = mock(() => fakePayer())
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'Payments are not set up',
  )
  await enableSigner('disabled')
  await expect(payHttp(deps({ payer }), grant, input())).rejects.toThrow(
    'Payments are not set up',
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

test('a client without the payments scope is refused before any request or record', async () => {
  const grant = await connectClient(50_000, { scope: 'account:read' })
  await enableSigner()
  const fetch = mock(async () => new Response('free'))
  await expect(
    payHttp(
      deps({ fetch: fetch as unknown as typeof globalThis.fetch }),
      grant,
      input(),
    ),
  ).rejects.toThrow('not allowed to make payments')
  expect(fetch).not.toHaveBeenCalled()
  expect(await activity()).toEqual([])
})

async function ageActivity(minutes: number) {
  await drizzle(db)
    .update(paymentActivity)
    .set({ createdAt: Date.now() - minutes * 60_000 })
    .where(eq(paymentActivity.privyUserId, user))
}

async function endedCall(
  grant: Awaited<ReturnType<typeof connectClient>>,
  { signed }: { signed: boolean },
) {
  // A call whose Worker stopped after reserving, before it could close.
  const id = await reserve(
    db,
    grant,
    'wallet-1',
    { method: 'GET', origin: 'https://merchant.example', path: '/' },
    {
      protocol: 'x402',
      amount: 10_000n,
      mint: DEVNET.usdcMint,
      recipient: MERCHANT,
      network: 'devnet',
    },
  )
  if (signed && id)
    await recordSigning(db, id, {
      payerWallet: WALLET,
      payerSignature: PAYER_SIGNATURE,
      blockhash: BLOCKHASH,
    })
  return id
}

for (const [signed, error] of [
  [false, 'ended before anything was signed'],
  [true, 'may have charged the wallet'],
] as const)
  test(`the next call fails an ended reservation, ${signed ? 'signed' : 'never signed'}`, async () => {
    const grant = await connectClient(10_000)
    await enableSigner()
    const ended = await endedCall(grant, { signed })
    await expect(payHttp(deps(), grant, input())).rejects.toThrow(
      'remaining limit of $0.00',
    )
    await ageActivity(10)

    const result = await payHttp(deps(), grant, input())
    expect(result.payment?.state).toBe('paid')
    const row = (await activity()).find((a) => a.id === ended)
    expect(row?.status).toBe('failed')
    expect(row?.error).toContain(error)
    expect(await totals()).toEqual({ spent: 10_000, reserved: 0 })
  })

test('a reservation of a call still running is left alone', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  const running = await endedCall(grant, { signed: true })
  await payHttp(deps(), grant, input())
  const row = (await activity()).find((a) => a.id === running)
  expect(row?.status).toBe('reserved')
  expect(await totals()).toEqual({ spent: 10_000, reserved: 10_000 })
})

test('a closed reservation can never be signed', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  let refused: unknown
  const payer: Payer = async ({ onSigned }) => {
    await drizzle(db)
      .update(paymentActivity)
      .set({ status: 'failed' })
      .where(eq(paymentActivity.privyUserId, user))
    refused = await onSigned(PAYER_SIGNATURE, BLOCKHASH).catch((e) => e)
    throw refused
  }
  await payHttp(deps({ payer: () => payer }), grant, input()).catch(() => {})
  expect(String(refused)).toContain('can no longer be signed')
})

test('concurrent calls closing the same ended reservation both go through', async () => {
  const grant = await connectClient(50_000)
  await enableSigner()
  await endedCall(grant, { signed: true })
  await ageActivity(10)

  const results = await Promise.all([
    payHttp(deps(), grant, input()),
    payHttp(deps(), grant, input()),
  ])
  expect(results.map((r) => r.payment?.state)).toEqual(['paid', 'paid'])
  expect((await activity()).map((a) => a.status).sort()).toEqual([
    'failed',
    'paid',
    'paid',
  ])
})
