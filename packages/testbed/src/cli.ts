import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { Subprocess } from 'bun'
import { generateKeyPairSigner } from '@solana/kit'
import {
  ClientPermissions,
  createPayKitClient,
  usd,
} from '@solana/pay-kit/client'
import { Receipt } from 'mppx'
import { MERCHANT_ORIGIN, selectProfile } from './networks'
import { tokenReceived } from './rpc'

const PRICE = 10_000n // 0.01 USDC in base units, as in merchant.yaml
const ROUTE = `${MERCHANT_ORIGIN}/api/v1/fixed`
const DIR = join(import.meta.dir, '..')

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { network: { type: 'string' } },
  allowPositionals: true,
})
const [command, url] = positionals

function fail(message: string): never {
  console.error(`testbed: ${message}`)
  process.exit(1)
}

let profile: ReturnType<typeof selectProfile>
try {
  profile = selectProfile(values.network)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}

// Only PATH and a private HOME reach pay: no shell credentials and none of the
// user's pay accounts.
const env = {
  PATH: process.env.PATH ?? '',
  HOME: join(profile.stateDir, 'home'),
}

let gateway: Subprocess | undefined
// pay's gateway ignores SIGINT and SIGTERM, so every exit path SIGKILLs it.
process.on('exit', () => gateway?.kill('SIGKILL'))
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const decode = <T>(base64url: string) =>
  JSON.parse(Buffer.from(base64url, 'base64url').toString()) as T

async function start() {
  if (await fetch(ROUTE).catch(() => null)) fail('port 1402 is already in use')
  await profile.preflight()
  if (profile.resetState)
    rmSync(profile.stateDir, { recursive: true, force: true })
  mkdirSync(env.HOME, { recursive: true })

  // One merchant spec for every network; only its operator network changes.
  const spec = Bun.YAML.parse(
    await Bun.file(join(DIR, 'merchant.yaml')).text(),
  ) as { operator: { network: string } }
  spec.operator.network = profile.network
  const specPath = join(profile.stateDir, 'merchant.yaml')
  await Bun.write(specPath, Bun.YAML.stringify(spec, null, 2))

  const argv = [
    ...profile.payFlags,
    'gate',
    'api',
    specPath,
    '--no-register',
    '--bind',
    '127.0.0.1:1402',
    ...profile.gateFlags(),
  ]
  const unfunded = await launch(argv)
  if (!unfunded) return
  // pay creates the fee payer on first start and refuses to run while it has
  // no SOL. Once funded, the persisted key serves later starts.
  if (!profile.fundFeePayer) fail(`gateway fee payer ${unfunded} has no SOL`)
  profile.fundFeePayer(unfunded)
  if (await launch(argv))
    fail(`gateway fee payer ${unfunded} is still unfunded`)
}

/**
 * Starts the gateway and waits for its route. Returns the fee payer address
 * when pay refuses to start because that wallet has no SOL.
 */
async function launch(argv: Array<string>) {
  const log = join(profile.stateDir, 'gateway.log')
  gateway = Bun.spawn(['pay', ...argv], {
    cwd: profile.stateDir,
    env,
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  })
  for (let i = 0; !(await fetch(ROUTE).catch(() => null)); i++) {
    if (gateway.exitCode !== null) {
      // pay prints this error as JSON, so the address follows an escaped
      // newline; accept a real line break too.
      const output = await Bun.file(log).text()
      const unfunded =
        /operator signer wallet has 0 SOL(?:\\n|\s)+([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(
          output,
        )?.[1]
      if (unfunded) return unfunded
      fail(`gateway did not start; see ${log}`)
    }
    if (i === 120) fail(`gateway did not start; see ${log}`)
    await Bun.sleep(500)
  }
}

/** pay's own client, for poking the sandbox merchant by hand. */
function pay() {
  // pay 0.28 rejects devnet challenges with a false "not enough balance"
  // error, so devnet payments go through Pay Kit (`check`, testbed:paykit).
  if (profile.name !== 'sandbox') fail('pay supports only the sandbox network')
  const run = Bun.spawnSync(
    ['pay', ...profile.payFlags, 'curl', '-s', '-i', url ?? ROUTE],
    { cwd: profile.stateDir, env },
  )
  if (!run.success) fail(`pay curl failed: ${run.stderr}${run.stdout}`)
  return run.stdout.toString()
}

type Challenge = {
  amount: string
  currency: string
  recipient: string
  methodDetails: { network: string }
}

/** Pays the merchant once per protocol with Pay Kit and verifies on chain. */
async function check() {
  await start()

  const header = (await fetch(ROUTE)).headers.get('www-authenticate') ?? ''
  const request =
    /request="([^"]+)"/.exec(header)?.[1] ??
    fail(`no challenge in 402: ${header}`)
  const challenge = decode<Challenge>(request)
  // A challenge on any other network or mint could move real funds.
  if (
    challenge.methodDetails.network !== profile.network ||
    challenge.currency !== profile.usdcMint ||
    BigInt(challenge.amount) !== PRICE
  )
    fail(`unexpected challenge: ${JSON.stringify(challenge)}`)

  const protocols = ['mpp', 'x402'] as const
  const signer = await generateKeyPairSigner()
  await profile.fund(signer.address, PRICE * BigInt(protocols.length))
  // Signatures from Pay Kit's `paid` progress events, one per payment.
  const paid: Array<string> = []
  const client = await createPayKitClient({
    signer,
    rpcUrl: profile.rpcUrl,
    network: profile.network,
    permissions: ClientPermissions.builder()
      .allowNetwork(profile.network)
      .allowOrigin(MERCHANT_ORIGIN)
      .maxAmountPerPayment(usd('0.01'))
      .build(),
    onProgress: (event) => {
      const payment = event as { type: string; signature?: string }
      if (payment.type === 'paid' && payment.signature)
        paid.push(payment.signature)
    },
  })

  for (const protocol of protocols) {
    paid.length = 0
    const response = await client.fetch(ROUTE, undefined, protocol)
    if (response.status !== 200)
      fail(`${protocol} payment failed: HTTP ${response.status}`)
    const receipt =
      protocol === 'mpp'
        ? response.headers.get('payment-receipt')
        : response.headers.get('payment-response')
    // pay's gateway returns the raw x402 signature, which Pay Kit's receipt
    // decoder skips; see specs/adi-176-paykit-privy.md.
    const signature =
      protocol === 'mpp' && receipt
        ? Receipt.deserialize(receipt).reference
        : (paid.at(-1) ?? receipt ?? undefined)
    if (!signature) fail(`${protocol} payment returned no transaction`)

    // The receipt is the gateway's claim; the merchant's balance change is proof.
    const received = await tokenReceived(
      profile.rpcUrl,
      signature,
      challenge.recipient,
      profile.usdcMint,
    )
    if (received !== PRICE)
      fail(`${protocol}: merchant received ${received}, expected ${PRICE}`)
    console.log(`${protocol} paid ${PRICE} USDC base units in ${signature}`)
  }
  console.log(`testbed check passed on ${profile.name}`)
}

try {
  switch (command) {
    case 'start':
      await start()
      console.log(
        `merchant ${ROUTE} on ${profile.name} (${profile.rpcUrl}); Ctrl-C stops it`,
      )
      break
    case 'check':
      await check()
      process.exit(0) // the exit hook stops the gateway
      break
    case 'pay':
      process.stdout.write(pay())
      break
    default:
      fail('usage: testbed <start|check|pay [url]> [--network sandbox|devnet]')
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
