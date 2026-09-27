/**
 * ADI-176: Pay Kit paying from a server-authorized Privy wallet.
 *
 * One local process runs a Pay Kit merchant (a fixed 0.01 USDC charge) and the
 * payer side LanaTools will run. The proof page sends the signed-in user's
 * Privy access token with each request, so the token never leaves the browser
 * except to this server on 127.0.0.1.
 */
import { generateP256KeyPair, PrivyClient } from '@privy-io/node'
import { address, generateKeyPairSigner } from '@solana/kit'
import type { Address, KeyPairSigner } from '@solana/kit'
import { createPayKit, usd } from '@solana/pay-kit'
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
  setSol,
  setUsdc,
  solBalance,
  usdcBalance,
} from './surfnet'

const rpcUrl = 'http://127.0.0.1:8899'
const port = 1403
const merchantUrl = `http://127.0.0.1:${port}/merchant/fortune`
const price = usd('0.01')
const priceCap = usdCap('0.01')
const priceAtomic = 10_000n // 0.01 USDC, 6 decimals
const walletFunding = 1_000_000n // 1 USDC per top-up

const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET in the root .env')

await assertSurfpool(rpcUrl)
const privy = new PrivyClient({ appId, appSecret })

// The merchant operator receives payments and pays network fees.
const operator = await generateKeyPairSigner()
await setSol(rpcUrl, operator.address, 5_000_000_000n)
await setUsdc(rpcUrl, operator.address, 0n) // the payer never creates this ATA

const merchant = await createPayKit({
  accept: ['mpp', 'x402'],
  mpp: {
    challengeBindingSecret: Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString('hex'),
  },
  network: 'localnet',
  operator: { recipient: operator.address, signer: operator },
  pricing: { fortune: { amount: price, description: 'A fortune cookie' } },
  rpcUrl,
})
const fortune = merchant.fetch('fortune', () =>
  Response.json({ fortune: 'The settlement you await will confirm.' }),
)

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

type Mode = 'mpp' | 'x402' | 'denied'

type Check = { name: string; passed: boolean; detail: string }

async function balances(wallet: Address) {
  const [walletUsdc, merchantUsdc, walletSol] = await Promise.all([
    usdcBalance(rpcUrl, wallet),
    usdcBalance(rpcUrl, operator.address),
    solBalance(rpcUrl, wallet),
  ])
  return { walletUsdc, merchantUsdc, walletSol }
}

/** The transaction signature the merchant reports for a settled payment. */
function settlementSignature(response: Response) {
  const mpp = response.headers.get('payment-receipt')
  if (mpp)
    return {
      header: 'payment-receipt',
      signature: Receipt.deserialize(mpp).reference,
    }
  const x402 = response.headers.get('x-payment-response')
  if (x402) {
    const settled = JSON.parse(Buffer.from(x402, 'base64').toString()) as {
      transaction?: string
    }
    if (settled.transaction)
      return { header: 'x-payment-response', signature: settled.transaction }
  }
  return undefined
}

async function prove(mode: Mode, userId: string) {
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
    // x402 on Surfpool advertises the mainnet chain ID (the fork keeps the
    // mainnet genesis hash), so mainnet stays allowed; the origin allowlist and
    // local RPC keep payments on the fixture merchant.
    permissions: ClientPermissions.builder()
      .allowNetwork('localnet')
      .allowOrigin(new URL(merchantUrl).origin)
      .maxAmountPerPayment(mode === 'denied' ? usdCap('0.005') : priceCap)
      .build(),
    onProgress: (event) => progress.push((event as { type: string }).type),
  })

  const before = await balances(wallet.address)
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
    const after = await balances(wallet.address)
    check(
      'Payment refused before signing',
      rejections.length > 0,
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
    const response = await client.fetch(merchantUrl, undefined, mode)
    const body = await response.text()
    const settlement = settlementSignature(response)
    if (settlement) await confirmed(rpcUrl, settlement.signature)
    const after = await balances(wallet.address)
    check(
      'Merchant returned its result',
      response.status === 200,
      `HTTP ${response.status}: ${body.slice(0, 200)}`,
    )
    check(
      'Receipt names a transaction',
      !!settlement,
      settlement
        ? `${settlement.header}: ${settlement.signature}`
        : 'no receipt header',
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
      receiptHeader: settlement?.header,
      signature: settlement?.signature,
    }
  }

  return {
    mode,
    passed: checks.every((c) => c.passed),
    checks,
    progress,
    wallet: wallet.address,
    merchant: operator.address,
    priceAtomic: String(priceAtomic),
    durationMs: Math.round(performance.now() - started),
    ...result,
  }
}

// One proof at a time, so balance deltas belong to a single payment.
let queue: Promise<unknown> = Promise.resolve()
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
  if (mode !== 'mpp' && mode !== 'x402' && mode !== 'denied')
    return Response.json(
      { error: 'mode must be mpp, x402 or denied' },
      { status: 400 },
    )
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
    if (pathname === '/merchant/fortune') return fortune(request)
    if (pathname === '/testbed/pay' && request.method === 'POST')
      return handlePay(request)
    return new Response('Not found', { status: 404 })
  },
})
console.log(`Pay Kit proof server on ${server.url} (Surfpool ${rpcUrl})`)
console.log('Open http://localhost:5174 (bun run proof); Ctrl-C cleans up')

async function cleanup() {
  await server.stop(true)
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
