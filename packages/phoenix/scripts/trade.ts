import { readFileSync } from 'node:fs'
import {
  address,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
} from '@solana/kit'
import { runPhoenixTool } from '../src/index'
import {
  positionSize,
  runPhoenixTrade,
  submitSignedTransaction,
} from '../src/trade/index'
import type { PreparedTransaction, TradeRpc } from '../src/trade/index'
import { USAGE, UsageError, parseCli } from './args'
import { sign } from './sign'

/**
 * Runs the Phoenix trade tools from a terminal against Solana mainnet,
 * signing with a local keypair (the Solana CLI wallet by default). Every
 * send shows the tool's summary and simulation first and waits for a typed
 * "yes"; --dry-run never signs. The package itself never sees the key.
 */

/** Mainnet's genesis hash: the script refuses any other cluster. */
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/** D5: 20% compute margin, no priority fee. */
const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }

function fail(message: string): never {
  console.error(`trade: ${message}`)
  process.exit(1)
}

async function requireMainnet(rpc: TradeRpc) {
  let genesis
  try {
    genesis = await rpc.getGenesisHash().send()
  } catch {
    fail('Could not reach the RPC')
  }
  if (genesis !== MAINNET_GENESIS)
    fail(`The RPC is not Solana mainnet (genesis ${genesis}); refusing`)
}

async function loadSigner(path: string) {
  let bytes
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256)
    )
      throw new Error('not a 64-byte keypair')
    bytes = Uint8Array.from(parsed)
  } catch (error) {
    fail(
      `Could not read the keypair at ${path} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return createKeyPairSignerFromBytes(bytes)
}

function show(prepared: PreparedTransaction) {
  console.log(`\n${prepared.summary}\n`)
  for (const [key, value] of Object.entries(prepared.details))
    console.log(`  ${key}: ${value}`)
  for (const warning of prepared.warnings) console.log(`\n  ! ${warning}`)
  console.log(
    `\n  Simulation: ok, ${prepared.simulation.computeUnits} compute units`,
  )
}

async function printState(wallet: string) {
  const outcome = await runPhoenixTool('phoenix_get_account', { wallet })
  if (outcome.ok) console.log(JSON.stringify(outcome.result, null, 2))
  else if (outcome.error.code === 'not_found')
    console.log('No Phoenix account yet: run `activate` first.')
  else console.log(`Phoenix account: ${outcome.error.message}`)
}

async function main() {
  let args
  try {
    args = parseCli(Bun.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) fail(`${error.message}\n\n${USAGE}`)
    throw error
  }

  const rpc = createSolanaRpc(args.rpc)
  await requireMainnet(rpc)
  const signer = args.as === null ? await loadSigner(args.keypair) : null
  const wallet = signer ? signer.address : address(String(args.as))
  console.log(`Wallet: ${wallet}${args.as ? ' (simulation only)' : ''}`)

  if (args.command === 'state') return printState(wallet)

  const outcome = await runPhoenixTrade(
    args.tool,
    { ...args.input, wallet },
    { rpc, fees: FEES },
  )
  if (!outcome.ok) fail(`${outcome.error.code}: ${outcome.error.message}`)
  const result = outcome.result
  if (result.status === 'nothing_to_do') {
    console.log(`\n${result.summary}`)
    return
  }
  if (result.status === 'simulation_failed') {
    console.log(`\n${result.summary}\n`)
    fail(
      `The simulation failed, so there is nothing to sign: ${result.simulation.error ?? 'no reason given'}`,
    )
  }

  show(result)
  if (args.dryRun || !signer) {
    console.log('\nDry run: nothing was signed or sent.')
    return
  }

  const answer = prompt('\nType yes to sign and send on mainnet:')
  if (answer?.trim() !== 'yes') fail('Not sent.')

  const signed = await sign(result, signer)
  // Read the position just before sending, to report what actually filled.
  const before = result.position
    ? await positionSize(rpc, wallet, result.position)
    : null
  const sent = await submitSignedTransaction(result, signed, { rpc })
  console.log(`\nResult: ${sent.status}`)
  console.log(`Signature: ${sent.signature}`)
  console.log(`Explorer: https://explorer.solana.com/tx/${sent.signature}`)
  if ('error' in sent && sent.error) console.log(`Error: ${sent.error}`)
  if (sent.status === 'unknown')
    console.log(
      'It may still land. Check the signature before trying again; do not resend blindly.',
    )
  if (sent.status === 'confirmed' && result.position && before !== null) {
    const after = await positionSize(rpc, wallet, result.position)
    const { symbol } = result.position
    console.log(`\nPosition ${symbol}: ${before} → ${after}`)
    if (after === before)
      console.log(
        'Nothing filled: the transaction landed, but no part of the order traded.',
      )
  }
  console.log('\nPhoenix account now:')
  await printState(wallet)
  if (sent.status !== 'confirmed') process.exit(1)
}

await main()
