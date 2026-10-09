import { address, isSignerRole } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import {
  EMBER_PROGRAM,
  EMBER_STATE,
  MAX_POSITIONS,
  PHOENIX_PROGRAM,
  cancelData,
  collateralAmounts,
  decodeOrder,
  decodeRegisterTrader,
  expectedPacket,
  isOnboardTraderDelegated,
  orderData,
} from './rise'
import type { CancelTarget, OrderSpec } from './rise'

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

const bytesOf = (instruction: Instruction | undefined) =>
  Uint8Array.from(instruction?.data ?? [])

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index])

/**
 * Decodes an order instruction and compares it with the order the tool
 * meant to build: field by field, for a clear reason, then byte for byte, so
 * nothing else in the packet (flags, self-trade rule, trailing bytes) can
 * differ. An order without a price limit never passes: Phoenix would fill it
 * at any price.
 */
export function checkOrder(instruction: Instruction, spec: OrderSpec) {
  if (instruction.programAddress !== PHOENIX_PROGRAM)
    fail('the order is not a Phoenix instruction')
  const data = bytesOf(instruction)
  const packet = decodeOrder(data)
  if (!packet) fail('the instruction is not a Phoenix order')
  if (packet.priceInTicks === null) fail('the order has no price limit')
  const expected = expectedPacket(spec)
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
  if (!sameBytes(data, orderData(spec)))
    fail("the order's encoding differs from the request")
}

/**
 * A cancel must be exactly the Phoenix instruction for these orders (or for
 * all of the account's orders in the market, when `targets` is null).
 */
export function checkCancel(
  instruction: Instruction,
  targets: readonly CancelTarget[] | null,
) {
  if (instruction.programAddress !== PHOENIX_PROGRAM)
    fail('the cancel is not a Phoenix instruction')
  if (!sameBytes(bytesOf(instruction), cancelData(targets)))
    fail('the cancel does not match the orders requested')
}

// SPL token instruction tags: Approve is 4; the associated token program's
// CreateIdempotent is 1.
const APPROVE = 4
const CREATE_IDEMPOTENT = 1

function checkCreateAccount(instruction: Instruction | undefined) {
  const data = bytesOf(instruction)
  if (
    instruction?.programAddress !== ASSOCIATED_TOKEN_PROGRAM ||
    !sameBytes(data, Uint8Array.of(CREATE_IDEMPOTENT))
  )
    fail('a token account step is not an idempotent create')
}

function checkAmount(
  instruction: Instruction | undefined,
  program: Address,
  read: (data: Uint8Array) => bigint | null,
  amount: bigint,
  step: string,
) {
  if (instruction?.programAddress !== program)
    fail(`the ${step} step calls the wrong program`)
  if (read(bytesOf(instruction)) !== amount)
    fail(`the ${step} amount does not match the request`)
}

/**
 * Checks a deposit or withdrawal step by step: the programs in order, every
 * amount equal to the request, and a withdrawal's token approval limited to
 * that amount and delegated to Ember only.
 */
export function checkCollateral(
  instructions: readonly Instruction[],
  { kind, amount }: { kind: 'deposit' | 'withdraw'; amount: bigint },
) {
  if (kind === 'deposit') {
    if (instructions.length !== 3) fail('the deposit has unexpected steps')
    const [create, wrap, deposit] = instructions
    checkCreateAccount(create)
    checkAmount(
      wrap,
      EMBER_PROGRAM,
      collateralAmounts.emberDeposit,
      amount,
      'Ember deposit',
    )
    checkAmount(
      deposit,
      PHOENIX_PROGRAM,
      collateralAmounts.depositFunds,
      amount,
      'Phoenix deposit',
    )
    return
  }
  if (instructions.length !== 5) fail('the withdrawal has unexpected steps')
  const [createPhoenixUsd, approve, createUsdc, withdraw, unwrap] = instructions
  checkCreateAccount(createPhoenixUsd)
  checkCreateAccount(createUsdc)
  const approval = bytesOf(approve)
  if (
    approve?.programAddress !== TOKEN_PROGRAM ||
    approval.length !== 9 ||
    approval[0] !== APPROVE ||
    new DataView(approval.buffer).getBigUint64(1, true) !== amount ||
    approve.accounts?.[1]?.address !== EMBER_STATE
  )
    fail('the token approval is not limited to the amount for Ember')
  checkAmount(
    withdraw,
    PHOENIX_PROGRAM,
    collateralAmounts.withdrawFunds,
    amount,
    'Phoenix withdrawal',
  )
  checkAmount(
    unwrap,
    EMBER_PROGRAM,
    collateralAmounts.emberWithdraw,
    amount,
    'Ember withdrawal',
  )
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
  if (register) {
    const params = decodeRegisterTrader(bytesOf(instructions[0]))
    if (!params) fail('activation does not register the trader')
    if (
      params.traderPdaIndex !== 0 ||
      params.subaccountIndex !== 0 ||
      params.maxPositions !== MAX_POSITIONS
    )
      fail('activation registers the wrong trader account')
  }
  if (!isOnboardTraderDelegated(bytesOf(instructions.at(-1))))
    fail('activation does not onboard the trader')
}
