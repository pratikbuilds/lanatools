import { address, isSignerRole } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import { EMBER_PROGRAM, PHOENIX_PROGRAM, decodeMarketOrder } from './rise'
import type { MarketOrderPacket } from './rise'

/**
 * Checks every instruction a trade tool built before it becomes a
 * transaction. A failure is a bug or an SDK change, never the caller's
 * input, so it is an error rather than a warning: nothing gets signed.
 */

export const TOKEN_PROGRAM = address(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
)
export const ASSOCIATED_TOKEN_PROGRAM = address(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
)

/**
 * Programs a trade tool may call. Compute budget instructions are not here:
 * the transaction builder adds them, a tool never does.
 */
export const TRADE_PROGRAMS: readonly Address[] = [
  PHOENIX_PROGRAM,
  EMBER_PROGRAM,
  TOKEN_PROGRAM,
  ASSOCIATED_TOKEN_PROGRAM,
]

export type CheckRules = {
  wallet: Address
  programs?: readonly Address[]
  /** Signers besides the wallet; only Phoenix's onboarder on activation. */
  coSigners?: readonly Address[]
}

function fail(reason: string): never {
  throw new PhoenixError(
    'check_failed',
    `The built Phoenix transaction failed a safety check (${reason}); nothing was signed`,
  )
}

export function checkInstructions(
  instructions: readonly Instruction[],
  { wallet, programs = TRADE_PROGRAMS, coSigners = [] }: CheckRules,
) {
  if (instructions.length === 0) fail('no instructions')
  let walletSigns = false
  for (const instruction of instructions) {
    if (!programs.includes(instruction.programAddress))
      fail(`unexpected program ${instruction.programAddress}`)
    for (const account of instruction.accounts ?? []) {
      if (!isSignerRole(account.role)) continue
      if (account.address === wallet) walletSigns = true
      else if (!coSigners.includes(account.address))
        fail(`unexpected signer ${account.address}`)
    }
  }
  if (!walletSigns) fail('the wallet does not sign')
}

/**
 * Decodes a market order instruction and compares it with what the tool
 * meant to build. An order without a price limit never passes: Phoenix would
 * fill it at any price.
 */
export function checkMarketOrder(
  instruction: Instruction,
  expected: MarketOrderPacket,
) {
  if (instruction.programAddress !== PHOENIX_PROGRAM)
    fail('the order is not a Phoenix instruction')
  const packet = instruction.data
    ? decodeMarketOrder(Uint8Array.from(instruction.data))
    : null
  if (!packet) fail('the order is not a market order')
  if (packet.priceInTicks === null) fail('the order has no price limit')
  for (const field of [
    'side',
    'priceInTicks',
    'numBaseLots',
    'minBaseLotsToFill',
    'lastValidSlot',
    'reduceOnly',
  ] as const)
    if (packet[field] !== expected[field])
      fail(`the order's ${field} does not match the request`)
}
