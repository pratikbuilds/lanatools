import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Subprocess } from 'bun'

const RPC_URL = 'https://402.surfnet.dev:8899' // hosted Surfpool behind `pay --sandbox`
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PRICE = 10_000 // 0.01 USDC in base units, as in merchant.yaml
const ROUTE = 'http://127.0.0.1:1402/api/v1/fixed'
const DIR = join(import.meta.dir, '..')
const STATE = join(DIR, '.state')

// Only PATH and a throwaway HOME reach pay: no shell credentials, none of the
// user's pay accounts, and fresh sandbox wallets whenever STATE is reset.
const env = { PATH: process.env.PATH ?? '', HOME: join(STATE, 'home') }

let gateway: Subprocess | undefined
// pay's gateway ignores SIGINT and SIGTERM, so every exit path SIGKILLs it.
process.on('exit', () => gateway?.kill('SIGKILL'))
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

function fail(message: string): never {
  console.error(`testbed: ${message}`)
  process.exit(1)
}

const decode = <T>(base64url: string) =>
  JSON.parse(Buffer.from(base64url, 'base64url').toString()) as T

async function start() {
  if (await fetch(ROUTE).catch(() => null)) fail('port 1402 is already in use')
  rmSync(STATE, { recursive: true, force: true })
  mkdirSync(env.HOME, { recursive: true })
  const log = join(STATE, 'gateway.log')
  gateway = Bun.spawn(
    [
      'pay',
      '--sandbox',
      'gate',
      'api',
      join(DIR, 'merchant.yaml'),
      '--no-register',
      '--bind',
      '127.0.0.1:1402',
    ],
    { cwd: STATE, env, stdout: Bun.file(log), stderr: Bun.file(log) },
  )
  for (let i = 0; !(await fetch(ROUTE).catch(() => null)); i++) {
    if (gateway.exitCode !== null || i === 120)
      fail(`gateway did not start; see ${log}`)
    await Bun.sleep(500)
  }
}

function pay() {
  const url = process.argv[3] ?? ROUTE
  const run = Bun.spawnSync(['pay', '--sandbox', 'curl', '-s', '-i', url], {
    cwd: STATE,
    env,
  })
  if (!run.success) fail(`pay curl failed: ${run.stderr}${run.stdout}`)
  return run.stdout.toString()
}

type Challenge = {
  amount: string
  currency: string
  recipient: string
  methodDetails: { network: string }
}
type Balance = {
  owner: string
  mint: string
  uiTokenAmount: { amount: string }
}
type Transaction = {
  meta: {
    err: unknown
    preTokenBalances: Array<Balance>
    postTokenBalances: Array<Balance>
  }
}

async function check() {
  await start()

  const header = (await fetch(ROUTE)).headers.get('www-authenticate') ?? ''
  const request =
    /request="([^"]+)"/.exec(header)?.[1] ??
    fail(`no challenge in 402: ${header}`)
  const challenge = decode<Challenge>(request)
  // --sandbox forces localnet; any other network could move real funds.
  if (
    challenge.methodDetails.network !== 'localnet' ||
    challenge.currency !== USDC_MINT ||
    Number(challenge.amount) !== PRICE
  ) {
    fail(`unexpected challenge: ${JSON.stringify(challenge)}`)
  }

  const response = pay()
  const receipt = /^payment-receipt: (\S+)/im.exec(response)?.[1]
  if (!response.startsWith('HTTP/1.1 200') || !receipt)
    fail(`payment failed:\n${response}`)
  const signature = decode<{ reference: string }>(receipt).reference

  // The receipt is the gateway's claim; the merchant's balance change is proof.
  const received = await usdcReceived(signature, challenge.recipient)
  if (received !== PRICE)
    fail(`merchant received ${received}, expected ${PRICE}`)
  console.log(
    `paid ${PRICE} USDC base units in ${signature}\ntestbed check passed`,
  )
}

async function usdcReceived(signature: string, owner: string) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ],
  })
  const usdc = (balances: Array<Balance>) =>
    balances
      .filter((b) => b.owner === owner && b.mint === USDC_MINT)
      .reduce((sum, b) => sum + Number(b.uiTokenAmount.amount), 0)
  // The RPC can lag the gateway: try 20 times, 500 ms apart.
  for (let i = 0; i < 20; i++) {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const tx = ((await res.json()) as { result: Transaction | null }).result
    if (tx?.meta.err) fail(`transaction ${signature} failed on chain`)
    if (tx)
      return usdc(tx.meta.postTokenBalances) - usdc(tx.meta.preTokenBalances)
    await Bun.sleep(500)
  }
  fail(`transaction ${signature} not found on ${RPC_URL}`)
}

try {
  switch (process.argv[2]) {
    case 'start':
      await start()
      console.log(`merchant ${ROUTE} on ${RPC_URL}; Ctrl-C stops it`)
      break
    case 'check':
      await check()
      process.exit(0) // the exit hook stops the gateway
      break
    case 'pay':
      process.stdout.write(pay())
      break
    default:
      fail('usage: testbed <start|check|pay [url]>')
  }
} catch (error) {
  fail(String(error))
}
