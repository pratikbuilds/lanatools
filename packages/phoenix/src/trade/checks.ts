import { address, isSignerRole } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import {
  EMBER_PROGRAM,
  MAX_POSITIONS,
  PHOENIX_PROGRAM,
  decodeOrder,
  decodeRegisterTrader,
  isOnboardTraderDelegated,
} from './rise'
import type { OrderPacket } from './rise'

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

/**
 * Every instruction calls an allowed program, and nobody but the wallet (and
 * named co-signers) signs. The wallet always signs as the fee payer, so an
 * instruction need not list it.
 */
export function checkInstructions(
  instructions: readonly Instruction[],
  { wallet, programs = TRADE_PROGRAMS, coSigners = [] }: CheckRules,
) {
  if (instructions.length === 0) fail('no instructions')
  for (const instruction of instructions) {
    if (!programs.includes(instruction.programAddress))
      fail(`unexpected program ${instruction.programAddress}`)
    for (const account of instruction.accounts ?? [])
      if (
        isSignerRole(account.role) &&
        account.address !== wallet &&
        !coSigners.includes(account.address)
      )
        fail(`unexpected signer ${account.address}`)
  }
}

/**
 * Decodes an order instruction and compares every field with what the tool
 * meant to build. An order without a price limit never passes: Phoenix would
 * fill it at any price.
 */
export function checkOrder(instruction: Instruction, expected: OrderPacket) {
  if (instruction.programAddress !== PHOENIX_PROGRAM)
    fail('the order is not a Phoenix instruction')
  const packet = instruction.data
    ? decodeOrder(Uint8Array.from(instruction.data))
    : null
  if (!packet) fail('the instruction is not a Phoenix order')
  if (packet.priceInTicks === null) fail('the order has no price limit')
  for (const field of [
    'kind',
    'side',
    'priceInTicks',
    'numBaseLots',
    'minBaseLotsToFill',
    'lastValidSlot',
    'reduceOnly',
    'slide',
    'cancelExisting',
  ] as const)
    if (packet[field] !== expected[field])
      fail(`the order's ${field} does not match the request`)
}

/**
 * Checks Rise's referral activation against what Phoenix's onboarding
 * expects: `RegisterTrader` for the default cross-margin account when it is
 * missing, then `OnboardTraderDelegated`, both for the wallet's own trader
 * account. Same idea as solOS's onboarding guards.
 */
export function checkActivation(
  instructions: readonly Instruction[],
  { traderAccount, register }: { traderAccount: Address; register: boolean },
) {
  if (instructions.length !== (register ? 2 : 1))
    fail('activation has unexpected instructions')
  const touchesTrader = (instruction: Instruction) =>
    (instruction.accounts ?? []).some(
      (account) => account.address === traderAccount,
    )
  for (const instruction of instructions) {
    if (instruction.programAddress !== PHOENIX_PROGRAM)
      fail('activation calls another program')
    if (!touchesTrader(instruction))
      fail("activation is not for the wallet's trader account")
  }
  const data = (instruction: Instruction | undefined) =>
    Uint8Array.from(instruction?.data ?? [])
  if (register) {
    const params = decodeRegisterTrader(data(instructions[0]))
    if (!params) fail('activation does not register the trader')
    if (
      params.traderPdaIndex !== 0 ||
      params.subaccountIndex !== 0 ||
      params.maxPositions !== MAX_POSITIONS
    )
      fail('activation registers the wrong trader account')
  }
  if (!isOnboardTraderDelegated(data(instructions.at(-1))))
    fail('activation does not onboard the trader')
}
