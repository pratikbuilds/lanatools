/**
 * Runs LanaTools on this machine against Solana devnet.
 *
 *   bun run dev                         web, API and MCP
 *   bun run dev:reset                   clear the local database and OAuth state
 *   bun run dev:fund <wallet> <usdc>    send devnet USDC from the Solana CLI wallet
 *
 * Secrets come only from the root `.env` (see `.env.example`). Startup refuses
 * the production Privy app, a non-devnet RPC and remote Cloudflare bindings.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { paymentConfig } from '../apps/api/src/solana/network'
import { profiles } from '../packages/testbed/src/networks'
import { checkLocalConfig, checkLocalEnv, parseUsdc } from './local-env'

const ROOT = join(import.meta.dir, '..')
const ENV_FILE = join(ROOT, '.env')
const STATE = join(ROOT, 'apps/api/.wrangler/state')
const API_CONFIG = 'apps/api/wrangler.local.jsonc'
const MCP_CONFIG = 'apps/mcp/wrangler.local.jsonc'
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler')
const MERCHANT =
  'https://devnet-merchant-production.up.railway.app/api/v1/fixed'

/**
 * A local Worker. Both share one state directory, so the API's D1 and the
 * MCP Worker's OAuth KV live together, and reach each other through
 * Wrangler's local dev registry. Each needs its own inspector port.
 */
function worker(name: string, config: string, port: number, inspector: number) {
  return {
    name,
    ports: [port, inspector],
    cwd: ROOT,
    cmd: [
      WRANGLER,
      'dev',
      '-c',
      config,
      '--port',
      String(port),
      '--inspector-port',
      String(inspector),
      '--local',
      '--persist-to',
      STATE,
      '--env-file',
      ENV_FILE,
    ],
  }
}

// MCP's port must match MCP_ORIGIN in its local config. The web dev server
// proxies /api to the API's port.
const SERVICES = [
  worker('api', API_CONFIG, 3000, 9230),
  worker('mcp', MCP_CONFIG, 8788, 9231),
  {
    name: 'web',
    ports: [5173],
    cwd: join(ROOT, 'apps/web'),
    cmd: [
      join(ROOT, 'apps/web/node_modules/.bin/vite'),
      '--port',
      '5173',
      '--strictPort',
    ],
  },
]

function fail(message: string): never {
  console.error(`dev: ${message}`)
  process.exit(1)
}

/** Runs a setup command to completion with the given environment. */
function run(cmd: Array<string>, env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(cmd, {
    cwd: ROOT,
    env,
    // No terminal input, so Wrangler applies local migrations without asking.
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (!result.success) fail(`${cmd.slice(0, 3).join(' ')} failed`)
}

function migrate() {
  run(
    [
      WRANGLER,
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '-c',
      API_CONFIG,
      '--persist-to',
      STATE,
    ],
    process.env,
  )
}

function canListen(port: number, host: string) {
  return new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

// `localhost` may resolve to either address, so both must be free.
async function portInUse(port: number) {
  const free = await Promise.all([
    canListen(port, '127.0.0.1'),
    canListen(port, '::1'),
  ])
  return free.includes(false)
}

async function busyPorts() {
  const ports = SERVICES.flatMap((service) => service.ports)
  const busy = await Promise.all(ports.map(portInUse))
  return ports.filter((_, index) => busy[index])
}

/**
 * Fails unless the secrets, RPC and local configs are safe to start. Checks
 * the `.env` file itself, which is what the Workers load, not the shell.
 */
async function preflight() {
  if (!existsSync(ENV_FILE)) fail('Copy .env.example to .env and fill it in')
  const secrets = parseEnv(readFileSync(ENV_FILE, 'utf8'))
  const problems = [
    ...checkLocalEnv(secrets),
    ...[API_CONFIG, MCP_CONFIG].flatMap((path) =>
      checkLocalConfig(path, readFileSync(join(ROOT, path), 'utf8')),
    ),
  ]
  if (problems.length) fail(problems.join('\n     '))
  try {
    // The same check the API makes before it pays.
    await paymentConfig({
      SOLANA_NETWORK: 'devnet',
      SOLANA_RPC_URL: secrets.SOLANA_RPC_URL ?? '',
    })
  } catch (error) {
    fail(
      `SOLANA_RPC_URL: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return secrets
}

/** Prefixes each line a service prints with its name. */
async function relay(name: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder()
  let rest = ''
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) console.log(`[${name}] ${line}`)
  }
  if (rest) console.log(`[${name}] ${rest}`)
}

async function start() {
  const secrets = await preflight()
  const busy = await busyPorts()
  if (busy.length)
    fail(`Port ${busy.join(', ')} is in use; stop what is using it`)

  // Vite lets process variables override .env files, so the browser and the
  // API always use the same Privy app.
  const env = {
    ...process.env,
    VITE_PRIVY_APP_ID: secrets.PRIVY_APP_ID,
    VITE_SOLANA_NETWORK: 'devnet',
  }
  migrate()
  run(['bun', 'run', '--cwd', 'apps/mcp', 'build'], env)

  const children = SERVICES.map((service) => {
    const child = Bun.spawn(service.cmd, {
      cwd: service.cwd,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    void relay(service.name, child.stdout)
    void relay(service.name, child.stderr)
    return child
  })

  let stopping = false
  const stop = (code: number, reason?: string) => {
    if (stopping) return
    stopping = true
    if (reason) console.error(`dev: ${reason}`)
    process.exitCode = code
    for (const child of children) child.kill()
  }
  process.on('SIGINT', () => stop(0, 'interrupted; stopping all services'))
  process.on('SIGTERM', () => stop(0, 'asked to stop; stopping all services'))

  console.log(`
dev: LanaTools on Solana devnet
     Dashboard  http://localhost:5173
     MCP        http://localhost:8788/mcp
     Merchant   ${MERCHANT}
`)

  const first = await Promise.race(
    children.map((child, index) =>
      child.exited.then((code) => ({ name: SERVICES[index]?.name, code })),
    ),
  )
  stop(
    first.code || 1,
    `${first.name} stopped (exit ${first.code}); stopping the rest`,
  )
  await Promise.all(children.map((child) => child.exited))
}

async function reset() {
  if ((await busyPorts()).length) fail('Stop `bun run dev` before resetting')
  rmSync(STATE, { recursive: true, force: true })
  console.log('dev: cleared the local database and OAuth state')
  migrate()
}

async function fund(wallet: string | undefined, amount: string | undefined) {
  if (!wallet || !amount)
    fail('Usage: bun run dev:fund <wallet address> <USDC amount>')
  let units: bigint
  try {
    units = parseUsdc(amount)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  // Confirms the CLI's RPC is devnet before anything is sent.
  await profiles.devnet.preflight()
  await profiles.devnet.fund(
    wallet as Parameters<typeof profiles.devnet.fund>[0],
    units,
  )
  console.log(`dev: sent ${amount} devnet USDC to ${wallet}`)
}

const [command, ...args] = Bun.argv.slice(2)
if (command === 'start') await start()
else if (command === 'reset') await reset()
else if (command === 'fund') await fund(args[0], args[1])
else fail('Usage: bun scripts/dev.ts start | reset | fund <wallet> <usdc>')
