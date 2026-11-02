import { address, isSignerRole, isWritableRole } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import {
  EMBER_PROGRAM,
  EMBER_STATE,
  MAX_POSITIONS,
  MAX_SUBACCOUNTS,
  MIN_FILL_LOTS,
  PHOENIX_PROGRAM,
  cancelData,
  collateralAmounts,
  conditionalOrdersAddress,
  decodeBundleStep,
  decodeOrder,
  decodeRegisterTrader,
  expectedPacket,
  isOnboardTraderDelegated,
  orderData,
  traderAccountAddress,
  transferSolData,
} from './rise'
import type {
  CancelTarget,
  ConditionalPacket,
  OrderPacket,
  OrderSpec,
} from './rise'
import type { ExchangeKeys } from './schemas'

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
 * account.
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

/** What a tool asked Phoenix's server for; `checkPhoenixBundle` holds it to it. */
export type BundleIntent = {
  wallet: Address
  keys: ExchangeKeys
  market: { marketPubkey: string; splinePubkey: string; assetId: number }
  /** The order, or nothing when this bundle must place none. */
  order?: Pick<
    OrderPacket,
    'kind' | 'side' | 'priceInTicks' | 'numBaseLots' | 'reduceOnly'
  >
  /** USDC base units moved from cross into the subaccount; default none. */
  collateralUsdc?: bigint
  /** Lamports moved from cross into the subaccount; default none. */
  collateralLamports?: bigint
  /** The position TP/SL this bundle must set, or nothing when none. */
  conditional?: ConditionalPacket
  /** The subaccount, when the tool knows it. New positions leave it out. */
  subaccount?: number
}

const sameTrigger = (
  left: ConditionalPacket['greater'],
  right: ConditionalPacket['greater'],
) =>
  left === right ||
  (left?.triggerDirection === right?.triggerDirection &&
    left?.side === right?.side &&
    left?.orderKind === right?.orderKind &&
    left?.triggerPriceInTicks === right?.triggerPriceInTicks &&
    left?.executionPriceInTicks === right?.executionPriceInTicks)

/**
 * Every account Phoenix's bundle may write to: the wallet's own trader
 * accounts, one market, and the exchange's shared accounts. Money can only
 * move through a writable account, so this is what keeps a wrong server
 * answer away from another trader's account.
 */
async function subaccountsOf(wallet: Address) {
  const indexes = Array.from({ length: MAX_SUBACCOUNTS + 1 }, (_, i) => i)
  const addresses = await Promise.all(
    indexes.map((index) => traderAccountAddress(wallet, index)),
  )
  return new Map(addresses.map((account, index) => [account, index]))
}

/**
 * Holds a server-built Phoenix transaction to what the tool asked for, step
 * by step. Phoenix's server leaves steps out depending on the account, so
 * order and count are not fixed; what each step does is. Returns the
 * subaccount the bundle trades in. A wallet's cross account is subaccount 0.
 */
export async function checkPhoenixBundle(
  instructions: readonly Instruction[],
  intent: BundleIntent,
) {
  const { wallet, keys, market } = intent
  checkInstructions(instructions, { wallet, programs: [PHOENIX_PROGRAM] })

  const traders = await subaccountsOf(wallet)
  const shared = new Set<string>([
    wallet,
    keys.globalConfig,
    market.marketPubkey,
    market.splinePubkey,
    keys.perpAssetMap,
    ...keys.globalTraderIndex,
    ...keys.activeTraderBuffer,
  ])
  const touched = new Set<number>()
  const unknown: Address[] = []
  for (const instruction of instructions)
    for (const account of instruction.accounts ?? []) {
      if (!isWritableRole(account.role) || shared.has(account.address)) continue
      const subaccount = traders.get(account.address)
      if (subaccount === undefined) unknown.push(account.address)
      else touched.add(subaccount)
    }

  const children = [...touched].filter((index) => index !== 0)
  if (children.length > 1) fail('the bundle touches two isolated subaccounts')
  const subaccount = children[0] ?? 0
  if (intent.subaccount !== undefined && intent.subaccount !== subaccount)
    fail('the bundle trades in the wrong subaccount')
  const cross = await traderAccountAddress(wallet)
  const child = await traderAccountAddress(wallet, subaccount)
  const conditionals = await conditionalOrdersAddress(child)
  for (const account of unknown)
    if (account !== conditionals)
      fail(`the bundle writes to an unexpected account ${account}`)
  // Every bundle writes cross too, so where the order and TP/SL land must be
  // pinned: each names its trader account at 4, a TP/SL its account at 11.
  const inSubaccount = (instruction: Instruction) =>
    instruction.accounts?.[4]?.address === child

  let orders = 0
  let usdc = 0n
  let sol = 0
  let conditional = 0
  for (const instruction of instructions) {
    const data = bytesOf(instruction)
    const step = decodeBundleStep(data)
    if (!step) fail('the bundle holds an unknown Phoenix instruction')
    switch (step.kind) {
      case 'realloc':
      case 'sync':
      case 'sweep_usdc':
      case 'sweep_sol':
      case 'create_conditional':
        break
      case 'register':
        if (step.traderPdaIndex !== 0 || step.subaccount !== subaccount)
          fail('the bundle registers the wrong subaccount')
        break
      case 'transfer_usdc':
        // TransferCollateral names its source and destination at 4 and 5.
        if (
          instruction.accounts?.[4]?.address !== cross ||
          instruction.accounts[5]?.address !== child
        )
          fail('the collateral does not move from cross to the subaccount')
        usdc += step.amount
        break
      case 'transfer_sol':
        sol += 1
        if (!sameBytes(data, transferSolData(intent.collateralLamports ?? 0n)))
          fail('the SOL collateral does not match the request')
        break
      case 'order': {
        orders += 1
        const { order } = intent
        if (!order) fail('the bundle places an order nobody asked for')
        if (!inSubaccount(instruction))
          fail('the order is not placed in the subaccount')
        const { packet } = step
        if (packet.priceInTicks === null) fail('the order has no price limit')
        for (const field of [
          'kind',
          'side',
          'priceInTicks',
          'numBaseLots',
          'reduceOnly',
        ] as const)
          if (packet[field] !== order[field])
            fail(`the order's ${field} does not match the request`)
        if (
          packet.kind === 'market' &&
          packet.minBaseLotsToFill !== MIN_FILL_LOTS
        )
          fail("the order's minimum fill does not match the request")
        if (packet.cancelExisting || packet.slide)
          fail('the order cancels or moves orders nobody asked to')
        break
      }
      case 'place_conditional': {
        conditional += 1
        const wanted = intent.conditional
        if (!wanted) fail('the bundle sets a TP/SL nobody asked for')
        if (
          !inSubaccount(instruction) ||
          instruction.accounts?.[11]?.address !== conditionals
        )
          fail('the TP/SL is not set in the subaccount')
        const { packet } = step
        if (
          packet.assetId !== wanted.assetId ||
          packet.assetId !== market.assetId ||
          packet.sizeBaseLots !== wanted.sizeBaseLots ||
          packet.sizePercent !== wanted.sizePercent ||
          !sameTrigger(packet.greater, wanted.greater) ||
          !sameTrigger(packet.less, wanted.less)
        )
          fail('the TP/SL does not match the request')
        break
      }
      case 'cancel_conditional':
        fail('the bundle cancels a TP/SL nobody asked to')
    }
  }
  if (orders !== (intent.order ? 1 : 0)) fail('the order is missing')
  if (usdc !== (intent.collateralUsdc ?? 0n))
    fail('the USDC collateral does not match the request')
  if (sol !== ((intent.collateralLamports ?? 0n) > 0n ? 1 : 0))
    fail('the SOL collateral does not match the request')
  if (conditional !== (intent.conditional ? 1 : 0)) fail('the TP/SL is missing')
  return { subaccount }
}
