/**
 * ADI-176: Pay Kit paying from a server-authorized Privy wallet.
 *
 * The payer calls the existing pay.sh YAML merchant on the hosted Surfpool
 * sandbox. The proof page sends the signed-in user's
 * Privy access token with each request, so the token never leaves the browser
 * except to this server on 127.0.0.1.
 */
import { APIError, generateP256KeyPair, PrivyClient } from '@privy-io/node'
import { createPrivySigner } from '@solana/keychain-privy'
import { address } from '@solana/kit'
import type { Address, KeyPairSigner } from '@solana/kit'
import {
  ClientPermissions,
  createPayKitClient,
  PermissionDeniedError,
  usd as usdCap,
} from '@solana/pay-kit/client'
import { Receipt } from 'mppx'
import { isPolicyDenial } from './privy-policy-denial'
import { SpendLimit } from './spend-limit'
import {
  assertSurfpool,
  confirmed,
  setUsdc,
  solBalance,
  usdcBalance,
  USDC_MINT,
} from './surfnet'

const rpcUrl = 'https://402.surfnet.dev:8899'
const port = 1403
const merchantUrl = 'http://127.0.0.1:1402/api/v1/fixed'
const policyDeniedUrl = 'http://127.0.0.1:1402/api/v1/policy-denied'
const priceCap = usdCap('0.01')
const priceAtomic = 10_000n // 0.01 USDC, 6 decimals
const policyDeniedPriceAtomic = 20_000n
const walletCap = 100_000n // 0.10 USDC in this disposable proof wallet

const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET in the root .env')
const privyConfig = { appId, appSecret }

await assertSurfpool(rpcUrl)
const privy = new PrivyClient(privyConfig)

// The server key exists only in this process. Privy limits each transfer;
// SpendLimit limits total exposure through this local payer process.
const serverKey = await generateP256KeyPair()
const authorizationContext = {
  authorization_private_keys: [serverKey.privateKey],
}
let quorumId: string | undefined
const wallets = new Map<
  string,
  {
    id: string
    address: Address
    policyId: string
    accessToken: string
    limit: SpendLimit
    funded: boolean
  }
>()

async function walletFor(userId: string, accessToken: string) {
  const existing = wallets.get(userId)
  if (existing) {
    existing.accessToken = accessToken
    return existing
  }
  quorumId ??= (
    await privy.keyQuorums().create({
      display_name: `ADI-176 proof ${crypto.randomUUID()}`,
      public_keys: [serverKey.publicKey],
      authorization_threshold: 1,
    })
  ).id
  const policy = await privy.policies().create({
    name: 'ADI-176 bounded USDC payer',
    version: '1.0',
    chain_type: 'solana',
    owner: { user_id: userId },
    rules: [
      {
        name: 'Allow payment compute budget and memo',
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_program_instruction',
            field: 'programId',
            operator: 'in',
            value: [
              'ComputeBudget111111111111111111111111111111',
              'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            ],
          },
        ],
      },
      {
        name: 'Allow bounded USDC transfer to any merchant',
        method: 'signTransaction',
        action: 'ALLOW',
        conditions: [
          {
            field_source: 'solana_token_program_instruction',
            field: 'TransferChecked.mint',
            operator: 'eq',
            value: USDC_MINT,
          },
          {
            field_source: 'solana_token_program_instruction',
            field: 'TransferChecked.amount',
            operator: 'lte',
            value: String(priceAtomic),
          },
        ],
      },
    ],
  })
  try {
    const created = await privy.wallets().create({
      chain_type: 'solana',
      owner: { user_id: userId },
      additional_signers: [
        { signer_id: quorumId, override_policy_ids: [policy.id] },
      ],
      display_name: 'ADI-176 disposable Pay Kit proof',
    })
    const wallet = {
      id: created.id,
      address: address(created.address),
      policyId: policy.id,
      accessToken,
      limit: new SpendLimit(walletCap),
      funded: false,
    }
    wallets.set(userId, wallet)
    console.log(
      `Created wallet ${wallet.id} (${wallet.address}) for ${userId} with policy ${policy.id}`,
    )
    return wallet
  } catch (error) {
    await cleanupResource('policy', policy.id, () =>
      privy.policies().delete(policy.id, {
        authorization_context: { user_jwts: [accessToken] },
      }),
    )
    throw error
  }
}

type Mode = 'mpp' | 'x402' | 'denied' | 'policy-denied'

type Check = { name: string; passed: boolean; detail: string }

async function balances(wallet: Address, merchant: Address) {
  const [walletUsdc, merchantUsdc, walletSol] = await Promise.all([
    usdcBalance(rpcUrl, wallet),
    usdcBalance(rpcUrl, merchant),
    solBalance(rpcUrl, wallet),
  ])
  return { walletUsdc, merchantUsdc, walletSol }
}

/** Read the live terms before measuring the gateway's recipient balance. */
async function fixtureRecipient(url: string, expectedAmount: bigint) {
  const response = await fetch(url)
  const encoded = /request="([^"]+)"/.exec(
    response.headers.get('www-authenticate') ?? '',
  )?.[1]
  if (response.status !== 402 || !encoded)
    throw new Error(
      'YAML merchant is not serving an MPP challenge on port 1402',
    )
  const terms = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
    amount: string
    currency: string
    recipient: string
    methodDetails: { network: string }
  }
  if (
    terms.amount !== String(expectedAmount) ||
    terms.currency !== USDC_MINT ||
    terms.methodDetails.network !== 'localnet'
  )
    throw new Error('YAML merchant returned unexpected payment terms')
  return address(terms.recipient)
}

async function prove(mode: Mode, userId: string, accessToken: string) {
  const url = mode === 'policy-denied' ? policyDeniedUrl : merchantUrl
  const amount =
    mode === 'policy-denied' ? policyDeniedPriceAtomic : priceAtomic
  const merchant = await fixtureRecipient(url, amount)
  const wallet = await walletFor(userId, accessToken)
  if (!wallet.funded) {
    await setUsdc(rpcUrl, wallet.address, walletCap)
    wallet.funded = true
  }

  const signer = await createPrivySigner({
    ...privyConfig,
    walletId: wallet.id,
    authorizationContext,
  })
  if (signer.address !== wallet.address)
    throw new Error('Privy signer address differs from proof wallet')
  const progress: Array<string> = []
  let paidSignature: string | undefined
  const client = await createPayKitClient({
    // Pay Kit's type requires a local keyPair, although the payment paths use
    // the Kit signing methods. The official Privy signer has no local key.
    signer: signer as unknown as KeyPairSigner,
    rpcUrl,
    network: 'localnet',
    permissions: ClientPermissions.builder()
      .allowNetwork('localnet')
      .allowOrigin(new URL(merchantUrl).origin)
      .maxAmountPerPayment(
        mode === 'denied'
          ? usdCap('0.005')
          : mode === 'policy-denied'
            ? usdCap('0.02')
            : priceCap,
      )
      .build(),
    onProgress: (event) => {
      const payment = event as { type: string; signature?: string }
      progress.push(payment.type)
      if (payment.type === 'paid' && payment.signature)
        paidSignature = payment.signature
    },
  })

  const before = await balances(wallet.address, merchant)
  const started = performance.now()
  const checks: Array<Check> = []
  const check = (name: string, passed: boolean, detail: string) =>
    checks.push({ name, passed, detail })
  let result: Record<string, unknown> = {}

  if (mode === 'denied') {
    let rejections: Array<string> = []
    try {
      await client.fetch(merchantUrl)
    } catch (error) {
      if (!(error instanceof PermissionDeniedError)) throw error
      rejections = error.rejections.map((r) => `${r.code}: ${r.message}`)
    }
    const after = await balances(wallet.address, merchant)
    check(
      'Payment refused before signing',
      rejections.some((rejection) =>
        rejection.startsWith('amount_exceeds_limit:'),
      ),
      rejections.join('; ') || 'no rejection',
    )
    check(
      'Wallet USDC unchanged',
      after.walletUsdc === before.walletUsdc,
      `${before.walletUsdc} → ${after.walletUsdc}`,
    )
    check(
      'Merchant USDC unchanged',
      after.merchantUsdc === before.merchantUsdc,
      `${before.merchantUsdc} → ${after.merchantUsdc}`,
    )
    result = { rejections }
  } else if (mode === 'policy-denied') {
    const reservation = wallet.limit.reserve(amount)
    let denied = false
    try {
      await client.fetch(url, undefined, 'mpp')
    } catch (error) {
      if (!isPolicyDenial(error)) throw error
      denied = true
      wallet.limit.releaseUnsigned(reservation)
    }
    const after = await balances(wallet.address, merchant)
    check(
      'Privy refused the over-limit transfer',
      denied,
      denied ? 'policy_violation from Privy signer' : 'no policy denial',
    )
    check(
      'Wallet USDC unchanged',
      after.walletUsdc === before.walletUsdc,
      `${before.walletUsdc} → ${after.walletUsdc}`,
    )
    check(
      'Merchant USDC unchanged',
      after.merchantUsdc === before.merchantUsdc,
      `${before.merchantUsdc} → ${after.merchantUsdc}`,
    )
  } else {
    // A failed or timed-out fetch may already have signed or settled. Leave
    // its reservation held until the payment can be reconciled.
    const reservation = wallet.limit.reserve(amount)
    const response = await client.fetch(merchantUrl, undefined, mode)
    const body = await response.text()
    const receipt = response.headers.get(
      mode === 'mpp' ? 'payment-receipt' : 'payment-response',
    )
    let signature: string | undefined
    if (receipt && mode === 'mpp')
      signature = Receipt.deserialize(receipt).reference
    if (mode === 'x402')
      // The local pay.sh gateway returns the signature itself in this header.
      signature = paidSignature ?? receipt ?? undefined
    if (signature) await confirmed(rpcUrl, signature)
    const after = await balances(wallet.address, merchant)
    check(
      'Merchant returned its result',
      response.status === 200,
      `HTTP ${response.status}: ${body.slice(0, 200)}`,
    )
    check(
      'Receipt names a transaction',
      !!signature,
      signature
        ? `${mode} transaction: ${signature}`
        : 'no transaction receipt',
    )
    check(
      'Wallet paid exactly the price',
      before.walletUsdc - after.walletUsdc === amount,
      `${before.walletUsdc} → ${after.walletUsdc}`,
    )
    check(
      'Merchant received exactly the price',
      after.merchantUsdc - before.merchantUsdc === amount,
      `${before.merchantUsdc} → ${after.merchantUsdc}`,
    )
    check(
      'Merchant paid the network fee',
      after.walletSol === before.walletSol,
      `wallet SOL ${before.walletSol} → ${after.walletSol}`,
    )
    if (checks.every((c) => c.passed)) wallet.limit.settle(reservation, amount)
    result = {
      status: response.status,
      body,
      receiptHeader: receipt
        ? mode === 'mpp'
          ? 'payment-receipt'
          : 'payment-response'
        : undefined,
      signature,
    }
  }

  return {
    mode,
    passed: checks.every((c) => c.passed),
    checks,
    progress,
    wallet: wallet.address,
    policyId: wallet.policyId,
    walletLimitRemainingAtomic: String(wallet.limit.remaining),
    merchant,
    priceAtomic: String(amount),
    durationMs: Math.round(performance.now() - started),
    ...result,
  }
}

// One proof at a time, so balance deltas belong to a single payment.
let queue: Promise<unknown> = Promise.resolve()
let shuttingDown = false
function serialized<T>(run: () => Promise<T>) {
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}

async function handlePay(request: Request) {
  const token = /^Bearer (.+)$/.exec(
    request.headers.get('authorization') ?? '',
  )?.[1]
  if (!token) return Response.json({ error: 'Sign in first' }, { status: 401 })
  let userId: string
  try {
    userId = (await privy.utils().auth().verifyAccessToken(token)).user_id
  } catch {
    return Response.json(
      { error: 'Privy token is invalid or expired' },
      { status: 401 },
    )
  }
  const { mode } = (await request.json().catch(() => ({}))) as {
    mode?: unknown
  }
  if (
    mode !== 'mpp' &&
    mode !== 'x402' &&
    mode !== 'denied' &&
    mode !== 'policy-denied'
  )
    return Response.json(
      { error: 'mode must be mpp, x402, denied, or policy-denied' },
      { status: 400 },
    )
  if (shuttingDown)
    return Response.json({ error: 'Proof server is stopping' }, { status: 503 })
  try {
    return Response.json(await serialized(() => prove(mode, userId, token)))
  } catch (error) {
    console.error(error)
    return Response.json(
      {
        mode,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 120,
  fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/testbed/pay' && request.method === 'POST')
      return handlePay(request)
    return new Response('Not found', { status: 404 })
  },
})
console.log(`Pay Kit payer on ${server.url} (YAML merchant ${merchantUrl})`)
console.log('Open http://localhost:5174 (bun run proof); Ctrl-C cleans up')

async function cleanupResource(
  kind: string,
  id: string,
  remove: () => Promise<unknown>,
) {
  try {
    await remove()
    console.log(`Cleaned up ${kind} ${id}`)
  } catch (error) {
    const detail =
      error instanceof APIError
        ? `HTTP ${error.status} ${JSON.stringify(error.error)}`
        : String(error)
    console.error(`Cleanup failed for ${kind} ${id}: ${detail}`)
    process.exitCode = 1
  }
}

async function cleanup() {
  shuttingDown = true
  await server.stop(true)
  await queue
  for (const wallet of wallets.values())
    await cleanupResource('wallet', wallet.id, () =>
      // The archive endpoint rejects a request without a JSON body (HTTP 415).
      privy.wallets().archive(wallet.id, { body: {} }),
    )
  for (const wallet of wallets.values())
    await cleanupResource('policy', wallet.policyId, () =>
      privy.policies().delete(wallet.policyId, {
        authorization_context: { user_jwts: [wallet.accessToken] },
      }),
    )
  // A key quorum can only be deleted with its own key, which dies with this
  // process, so it must be deleted here or never.
  const quorum = quorumId
  if (quorum)
    await cleanupResource('key quorum', quorum, () =>
      privy
        .keyQuorums()
        .delete(quorum, { authorization_context: authorizationContext }),
    )
  process.exit()
}
process.once('SIGINT', () => void cleanup())
process.once('SIGTERM', () => void cleanup())
