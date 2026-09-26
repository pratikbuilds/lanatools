import { mkdirSync, openSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { SANDBOX_RPC_URL, USDC_MINT, usdcReceived } from './chain'

const MERCHANT_PORT = 1402
const MERCHANT_URL = `http://127.0.0.1:${MERCHANT_PORT}`
const FIXED_ROUTE = `${MERCHANT_URL}/api/v1/fixed`
const PACKAGE_DIR = resolve(import.meta.dir, '..')
const STATE_DIR = join(PACKAGE_DIR, '.state')
const HOME_DIR = join(STATE_DIR, 'home')

// Children get this environment and nothing else from the caller's shell, so
// production credentials and the user's pay accounts are never visible. With
// HOME inside the state directory, pay creates fresh sandbox wallets there.
const childEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: HOME_DIR,
  NO_COLOR: '1',
}

const children: Array<Subprocess> = []

function fail(message: string): never {
  console.error(`testbed: ${message}`)
  stop()
  process.exit(1)
}

async function portInUse(port: number) {
  try {
    const socket = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: { data() {} },
    })
    socket.end()
    return true
  } catch {
    return false
  }
}

async function waitFor(what: string, ready: () => Promise<boolean>) {
  for (let i = 0; i < 120; i++) {
    if (await ready().catch(() => false)) return
    await Bun.sleep(500)
  }
  fail(`${what} did not become ready; see ${STATE_DIR}`)
}

function spawnLogged(name: string, cmd: Array<string>) {
  const log = openSync(join(STATE_DIR, `${name}.log`), 'w')
  const child = Bun.spawn(cmd, {
    cwd: STATE_DIR,
    env: childEnv,
    stdout: log,
    stderr: log,
  })
  children.push(child)
  void child.exited.then((code) => {
    if (!stopping)
      fail(`${name} exited with code ${code}; see ${STATE_DIR}/${name}.log`)
  })
}

let stopping = false
// pay's servers ignore SIGINT and SIGTERM, so only SIGKILL stops them.
function stop() {
  stopping = true
  for (const child of children) child.kill('SIGKILL')
}

/** Fresh state on every run: new operator and payer wallets. */
async function start() {
  if (await portInUse(MERCHANT_PORT)) {
    fail(`port ${MERCHANT_PORT} is already in use`)
  }
  rmSync(STATE_DIR, { recursive: true, force: true })
  mkdirSync(HOME_DIR, { recursive: true })

  spawnLogged('merchant', [
    'pay',
    '--sandbox',
    'gate',
    'api',
    join(PACKAGE_DIR, 'merchant.yaml'),
    '--no-register',
    '--bind',
    `127.0.0.1:${MERCHANT_PORT}`,
  ])
  await waitFor(
    'merchant',
    async () => (await fetch(`${MERCHANT_URL}/health`)).ok,
  )
}

interface Challenge {
  amount: string
  currency: string
  recipient: string
  methodDetails: { network: string }
}

async function readChallenge() {
  const res = await fetch(FIXED_ROUTE)
  if (res.status !== 402)
    fail(`expected 402 from ${FIXED_ROUTE}, got ${res.status}`)
  const header = res.headers.get('www-authenticate') ?? ''
  const request = /request="([^"]+)"/.exec(header)?.[1]
  if (!request) fail(`402 carried no payment request: ${header}`)
  return JSON.parse(Buffer.from(request, 'base64url').toString()) as Challenge
}

async function payWithCli(url: string) {
  const child = Bun.spawn(['pay', '--sandbox', 'curl', '-s', '-i', url], {
    cwd: STATE_DIR,
    env: childEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) fail(`pay curl exited with ${code}: ${err || out}`)
  return out
}

async function check() {
  await start()

  const challenge = await readChallenge()
  if (challenge.currency !== USDC_MINT)
    fail(`challenge currency ${challenge.currency} is not USDC`)
  // Sandbox mode forces localnet; anything else means real funds could move.
  if (challenge.methodDetails.network !== 'localnet') {
    fail(`challenge network ${challenge.methodDetails.network} is not localnet`)
  }
  console.log(
    `402: ${challenge.amount} USDC base units to ${challenge.recipient}`,
  )

  const response = await payWithCli(FIXED_ROUTE)
  const status = /^HTTP\/[\d.]+ (\d+)/m.exec(response)?.[1]
  const receipt = /^payment-receipt: (\S+)/im.exec(response)?.[1]
  if (status !== '200' || !receipt)
    fail(`paid request did not succeed:\n${response}`)
  const { reference, status: receiptStatus } = JSON.parse(
    Buffer.from(receipt, 'base64url').toString(),
  ) as { reference: string; status: string }
  if (receiptStatus !== 'success') fail(`receipt status is ${receiptStatus}`)

  const received = await usdcReceived(reference, challenge.recipient)
  if (received !== BigInt(challenge.amount)) {
    fail(
      `merchant received ${received} base units, challenge asked for ${challenge.amount}`,
    )
  }
  console.log(
    `paid: 200 with receipt; transaction ${reference} moved ${received} to the merchant`,
  )
  console.log('testbed check passed')
  stop()
}

async function serve() {
  await start()
  console.log(`network    ${SANDBOX_RPC_URL} (hosted Surfpool sandbox)`)
  console.log(`merchant   ${MERCHANT_URL} (fixed charge: ${FIXED_ROUTE})`)
  console.log(`state      ${STATE_DIR}`)
  console.log('pay once   bun run testbed pay')
  console.log('Ctrl-C stops the merchant; the next start makes new wallets.')
  process.on('SIGINT', () => {
    stop()
    process.exit(0)
  })
}

async function pay() {
  const url = process.argv[3] ?? FIXED_ROUTE
  process.stdout.write(await payWithCli(url))
}

const commands: Record<string, () => Promise<void>> = {
  start: serve,
  check,
  pay,
}
const command = commands[process.argv[2] ?? '']
if (!command) fail('usage: testbed <start|check|pay [url]>')
try {
  await command()
} catch (error) {
  // Anything that throws after start() must still stop the gateway.
  fail(error instanceof Error ? error.message : String(error))
}
