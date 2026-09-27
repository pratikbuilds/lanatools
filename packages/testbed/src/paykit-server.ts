/**
 * ADI-176: Pay Kit paying from a server-authorized Privy wallet.
 *
 * The payer calls the existing pay.sh YAML merchant on the hosted Surfpool
 * sandbox. The proof page sends the signed-in user's
 * Privy access token with each request, so the token never leaves the browser
 * except to this server on 127.0.0.1.
 */
import { generateP256KeyPair, PrivyClient } from '@privy-io/node'
import { address } from '@solana/kit'
import type { Address, KeyPairSigner } from '@solana/kit'
import {
  ClientPermissions,
  createPayKitClient,
  PermissionDeniedError,
  usd as usdCap,
} from '@solana/pay-kit/client'
import { Receipt } from 'mppx'
import { createPrivyPayerSigner } from './privy-payer-signer'
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
const priceCap = usdCap('0.01')
const priceAtomic = 10_000n // 0.01 USDC, 6 decimals
const walletFunding = 1_000_000n // 1 USDC per top-up

const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET in the root .env')

await assertSurfpool(rpcUrl)
const privy = new PrivyClient({ appId, appSecret })

// The server key exists only in this process. Every wallet it creates lists
// the key's quorum as an additional signer with no Privy policy: the payer's
// amount cap is the control under test.
const serverKey = await generateP256KeyPair()
const authorizationContext = {
  authorization_private_keys: [serverKey.privateKey],
}
let quorumId: string | undefined
const wallets = new Map<string, { id: string; address: Address }>()

async function walletFor(userId: string) {
  const existing = wallets.get(userId)
  if (existing) return existing
  quorumId ??= (
    await privy.keyQuorums().create({
      display_name: `ADI-176 proof ${crypto.randomUUID()}`,
      public_keys: [serverKey.publicKey],
      authorization_threshold: 1,
    })
  ).id
  const created = await privy.wallets().create({
    chain_type: 'solana',
    owner: { user_id: userId },
    additional_signers: [{ signer_id: quorumId }],
    display_name: 'ADI-176 disposable Pay Kit proof',
  })
  const wallet = { id: created.id, address: address(created.address) }
  wallets.set(userId, wallet)
  console.log(`Created wallet ${wallet.id} (${wallet.address}) for ${userId}`)
  return wallet
}

type Mode = 'mpp' | 'denied'

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
async function fixtureRecipient() {
  const response = await fetch(merchantUrl)
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
    terms.amount !== String(priceAtomic) ||
    terms.currency !== USDC_MINT ||
    terms.methodDetails.network !== 'localnet'
  )
    throw new Error('YAML merchant returned unexpected payment terms')
  return address(terms.recipient)
}

async function prove(mode: Mode, userId: string) {
  const merchant = await fixtureRecipient()
  const wallet = await walletFor(userId)
  if ((await usdcBalance(rpcUrl, wallet.address)) < priceAtomic)
    await setUsdc(rpcUrl, wallet.address, walletFunding)

  let signerCalls = 0
  const signer = createPrivyPayerSigner({
    privy,
    walletId: wallet.id,
    address: wallet.address,
    authorizationContext,
    onSign: () => signerCalls++,
  })
  const progress: Array<string> = []
  const client = await createPayKitClient({
    // Pay Kit types the payer as a KeyPairSigner but only calls
    // signTransactions, so a remote partial signer satisfies it at runtime.
    signer: signer as unknown as KeyPairSigner,
    rpcUrl,
    network: 'localnet',
    permissions: ClientPermissions.builder()
      .allowNetwork('localnet')
      .allowOrigin(new URL(merchantUrl).origin)
      .maxAmountPerPayment(mode === 'denied' ? usdCap('0.005') : priceCap)
      .build(),
    onProgress: (event) => progress.push((event as { type: string }).type),
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
      'Privy never asked to sign',
      signerCalls === 0,
      `${signerCalls} signing calls`,
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
  } else {
    const response = await client.fetch(merchantUrl, undefined, 'mpp')
    const body = await response.text()
    const receipt = response.headers.get('payment-receipt')
    const signature = receipt && Receipt.deserialize(receipt).reference
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
      signature ? `payment-receipt: ${signature}` : 'no receipt header',
    )
    check(
      'Privy signed once',
      signerCalls === 1,
      `${signerCalls} signing calls`,
    )
    check(
      'Wallet paid exactly the price',
      before.walletUsdc - after.walletUsdc === priceAtomic,
      `${before.walletUsdc} → ${after.walletUsdc}`,
    )
    check(
      'Merchant received exactly the price',
      after.merchantUsdc - before.merchantUsdc === priceAtomic,
      `${before.merchantUsdc} → ${after.merchantUsdc}`,
    )
    check(
      'Merchant paid the network fee',
      after.walletSol === before.walletSol,
      `wallet SOL ${before.walletSol} → ${after.walletSol}`,
    )
    result = {
      status: response.status,
      body,
      receiptHeader: receipt ? 'payment-receipt' : undefined,
      signature,
    }
  }

  return {
    mode,
    passed: checks.every((c) => c.passed),
    checks,
    progress,
    wallet: wallet.address,
    merchant,
    priceAtomic: String(priceAtomic),
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
  if (mode !== 'mpp' && mode !== 'denied')
    return Response.json(
      { error: 'mode must be mpp or denied' },
      { status: 400 },
    )
  if (shuttingDown)
    return Response.json({ error: 'Proof server is stopping' }, { status: 503 })
  try {
    return Response.json(await serialized(() => prove(mode, userId)))
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

async function cleanup() {
  shuttingDown = true
  await server.stop(true)
  await queue
  for (const wallet of wallets.values()) {
    await privy
      .wallets()
      .archive(wallet.id)
      .then(() => console.log(`Archived wallet ${wallet.id}`))
      .catch(() => {
        console.error(`Could not archive wallet ${wallet.id}`)
        process.exitCode = 1
      })
  }
  if (quorumId)
    await privy
      .keyQuorums()
      .delete(quorumId, {})
      .then(() => console.log(`Deleted key quorum ${quorumId}`))
      .catch(() => {
        console.error(`Could not delete key quorum ${quorumId}`)
        process.exitCode = 1
      })
  process.exit()
}
process.once('SIGINT', () => void cleanup())
process.once('SIGTERM', () => void cleanup())
