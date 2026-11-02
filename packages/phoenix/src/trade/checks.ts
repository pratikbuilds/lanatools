import { address, isSignerRole, isWritableRole } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import {
  EMBER_PROGRAM,
  EMBER_STATE,
  MAX_POSITIONS,
  MAX_SUBACCOUNTS,
  PHOENIX_PROGRAM,
  ACCOUNT_AT,
  SYSTEM_PROGRAM,
  cancelData,
  collateralAmounts,
  conditionalOrdersAddress,
  decodeBundleStep,
  decodeOrder,
  decodeRegisterTrader,
  expectedPacket,
  isOnboardTraderDelegated,
  orderData,
  solData,
  traderAccountAddress,
} from './rise'
import type { CancelTarget, ConditionalPacket, OrderSpec } from './rise'
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

/**
 * `phoenix_deposit` alone may call the System program, to move a SOL deposit
 * into the wallet's own trader account (see `checkSolDeposit`).
 */
export const DEPOSIT_PROGRAMS: readonly Address[] = [
  ...TRADE_PROGRAMS,
  SYSTEM_PROGRAM,
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

/** One step of a SOL collateral instruction: its program and exact data. */
function checkSolStep(
  instruction: Instruction | undefined,
  program: Address,
  data: Uint8Array,
  step: string,
) {
  if (instruction?.programAddress !== program)
    fail(`the ${step} step calls the wrong program`)
  if (!sameBytes(bytesOf(instruction), data))
    fail(`the ${step} step does not match the request`)
}

function checkAccount(
  instruction: Instruction | undefined,
  index: number,
  expected: Address,
  what: string,
) {
  if (instruction?.accounts?.[index]?.address !== expected)
    fail(`the ${what} is not the wallet's own`)
}

type SolTerms = { wallet: Address; traderAccount: Address; lamports: bigint }

/**
 * A SOL deposit is exactly `ReallocTrader`, a System transfer, `SyncNative`,
 * all on the wallet's own trader account. The transfer's amount and
 * destination are the money: lamports sent anywhere else are gone, and a sync
 * of another account would leave them uncounted.
 */
export function checkSolDeposit(
  instructions: readonly Instruction[],
  { wallet, traderAccount, lamports }: SolTerms,
) {
  if (instructions.length !== 3) fail('the SOL deposit has unexpected steps')
  const [realloc, transfer, sync] = instructions
  checkSolStep(realloc, PHOENIX_PROGRAM, solData.realloc(), 'ReallocTrader')
  checkAccount(realloc, ACCOUNT_AT.realloc.payer, wallet, 'rent payer')
  checkAccount(realloc, ACCOUNT_AT.realloc.trader, wallet, 'trader authority')
  checkAccount(
    realloc,
    ACCOUNT_AT.realloc.traderAccount,
    traderAccount,
    'reallocated trader account',
  )
  checkSolStep(
    transfer,
    SYSTEM_PROGRAM,
    solData.transfer(lamports),
    'SOL transfer',
  )
  checkAccount(transfer, ACCOUNT_AT.transfer.source, wallet, 'SOL source')
  checkAccount(
    transfer,
    ACCOUNT_AT.transfer.destination,
    traderAccount,
    'SOL destination',
  )
  checkSolStep(sync, PHOENIX_PROGRAM, solData.sync(), 'SyncNative')
  checkAccount(
    sync,
    ACCOUNT_AT.sync.traderAccount,
    traderAccount,
    'synced trader account',
  )
}

/**
 * A SOL withdrawal is exactly one Phoenix `WithdrawNativeSol` of counted
 * lamports (`withoutExcess`), from the wallet's own trader account to the
 * wallet.
 */
export function checkSolWithdraw(
  instructions: readonly Instruction[],
  { wallet, traderAccount, lamports }: SolTerms,
) {
  if (instructions.length !== 1) fail('the SOL withdrawal has unexpected steps')
  const [withdraw] = instructions
  checkSolStep(
    withdraw,
    PHOENIX_PROGRAM,
    solData.withdraw(lamports),
    'WithdrawNativeSol',
  )
  checkAccount(
    withdraw,
    ACCOUNT_AT.withdraw.trader,
    wallet,
    'withdrawing authority',
  )
  checkAccount(
    withdraw,
    ACCOUNT_AT.withdraw.traderAccount,
    traderAccount,
    'withdrawn trader account',
  )
  checkAccount(
    withdraw,
    ACCOUNT_AT.withdraw.destination,
    wallet,
    'withdrawal destination',
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

/** One leg of one TP/SL slot to cancel. */
export type ConditionalCancel = { slot: number; leg: 'greater' | 'less' }

const cancelKey = ({ slot, leg }: ConditionalCancel) => `${slot}:${leg}`

/** The TP/SL account Phoenix's server creates; its size sets the rent. */
const CONDITIONAL_CAPACITY = 8

/** What a tool asked Phoenix's server for; `checkPhoenixBundle` holds it to it. */
export type BundleIntent = {
  wallet: Address
  keys: ExchangeKeys
  market: { marketPubkey: string; splinePubkey: string; assetId: number }
  /** The order, or nothing when this bundle must place none. */
  order?: OrderSpec
  /** USDC base units moved from cross into the subaccount; default none. */
  collateralUsdc?: bigint
  /** Lamports moved from cross into the subaccount; default none. */
  collateralLamports?: bigint
  /** The position TP/SL this bundle must set, or nothing when none. */
  conditional?: ConditionalPacket
  /** The TP/SL legs this bundle must cancel, or nothing when none. */
  cancels?: readonly ConditionalCancel[]
  /** The subaccount, when the tool knows it. New positions leave it out. */
  subaccount?: number
  /** Subaccounts a new isolated position must not land in. */
  occupied?: readonly number[]
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

/** The wallet's trader accounts, by subaccount: 0 is cross. */
const traderAccountsOf = (wallet: Address) =>
  Promise.all(
    Array.from({ length: MAX_SUBACCOUNTS + 1 }, (_, index) =>
      traderAccountAddress(wallet, index),
    ),
  )

/**
 * Finds the one subaccount a bundle trades in, from the accounts it writes.
 * A bundle may write only the wallet's own trader accounts, its TP/SL
 * account, one market and the exchange's shared accounts. Money can only
 * move through a writable account, so this is what keeps a wrong server
 * answer away from another trader's account.
 */
async function bundleScope(
  instructions: readonly Instruction[],
  { wallet, keys, market, ...intent }: BundleIntent,
) {
  const accounts = await traderAccountsOf(wallet)
  const traders = new Map(accounts.map((account, index) => [account, index]))
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
  if (intent.occupied?.includes(subaccount))
    fail('the bundle opens the position in a subaccount already in use')
  const cross = accounts[0]
  const child = accounts[subaccount]
  if (!cross || !child) fail('the bundle trades in an unknown subaccount')
  const conditionals = await conditionalOrdersAddress(child)
  for (const account of unknown)
    if (account !== conditionals)
      fail(`the bundle writes to an unexpected account ${account}`)
  return { subaccount, cross, child, conditionals }
}

const at = (instruction: Instruction, index: number) =>
  instruction.accounts?.[index]?.address

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
  const { wallet, market } = intent
  checkInstructions(instructions, { wallet, programs: [PHOENIX_PROGRAM] })
  const { subaccount, cross, child, conditionals } = await bundleScope(
    instructions,
    intent,
  )
  // Every bundle writes cross too, so where each step acts is pinned here.
  const moves = (instruction: Instruction, from: Address, to: Address) =>
    subaccount !== 0 &&
    at(instruction, ACCOUNT_AT.collateralMove.source) === from &&
    at(instruction, ACCOUNT_AT.collateralMove.destination) === to

  let orders = 0
  let usdc = 0n
  let sol = 0
  let conditional = 0
  const cancels = new Set((intent.cancels ?? []).map(cancelKey))
  for (const instruction of instructions) {
    const data = bytesOf(instruction)
    const step = decodeBundleStep(data)
    if (!step) fail('the bundle holds an unknown Phoenix instruction')
    switch (step.kind) {
      case 'realloc':
      case 'sync':
        break
      case 'sweep_usdc':
      case 'sweep_sol':
        if (!moves(instruction, child, cross))
          fail('a sweep does not move from the subaccount to cross')
        break
      case 'create_conditional':
        if (step.capacity !== CONDITIONAL_CAPACITY)
          fail('the TP/SL account is not the expected size')
        break
      case 'register':
        if (step.traderPdaIndex !== 0 || step.subaccount !== subaccount)
          fail('the bundle registers the wrong subaccount')
        // An isolated account holds one position, with Phoenix's defaults.
        if (step.maxPositions !== 1n || step.traderPreferenceBits !== 0)
          fail('the bundle registers a subaccount with other settings')
        break
      case 'transfer_usdc':
        if (!moves(instruction, cross, child))
          fail('the collateral does not move from cross to the subaccount')
        usdc += step.amount
        break
      case 'transfer_sol':
        if (!moves(instruction, cross, child))
          fail('the collateral does not move from cross to the subaccount')
        sol += 1
        if (
          !sameBytes(
            data,
            solData.toSubaccount(intent.collateralLamports ?? 0n),
          )
        )
          fail('the SOL collateral does not match the request')
        break
      case 'order': {
        orders += 1
        const { order } = intent
        if (!order) fail('the bundle places an order nobody asked for')
        if (at(instruction, ACCOUNT_AT.order.traderAccount) !== child)
          fail('the order is not placed in the subaccount')
        checkOrder(instruction, order)
        break
      }
      case 'place_conditional': {
        conditional += 1
        const wanted = intent.conditional
        if (!wanted) fail('the bundle sets a TP/SL nobody asked for')
        if (
          at(instruction, ACCOUNT_AT.placeConditional.traderAccount) !==
            child ||
          at(instruction, ACCOUNT_AT.placeConditional.conditionalOrders) !==
            conditionals
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
      case 'cancel_conditional': {
        // disableFirst is the greater leg, disableSecond the less. Rise does
        // not say so; a mainnet simulation showed it, from Phoenix's route
        // and from the accounts after each flag.
        if (step.disableFirst === step.disableSecond)
          fail('the TP/SL cancel does not name one leg')
        const leg = step.disableFirst ? 'greater' : 'less'
        if (!cancels.delete(cancelKey({ slot: step.index, leg })))
          fail('the bundle cancels a TP/SL nobody asked to')
        const { traderAccount, conditionalOrders } =
          ACCOUNT_AT.cancelConditional
        if (
          at(instruction, traderAccount) !== child ||
          at(instruction, ACCOUNT_AT.cancelConditional.market) !==
            market.marketPubkey ||
          at(instruction, conditionalOrders) !== conditionals
        )
          fail('the TP/SL cancel is for another account or market')
        break
      }
    }
  }
  if (orders !== (intent.order ? 1 : 0)) fail('the order is missing')
  if (usdc !== (intent.collateralUsdc ?? 0n))
    fail('the USDC collateral does not match the request')
  if (sol !== ((intent.collateralLamports ?? 0n) > 0n ? 1 : 0))
    fail('the SOL collateral does not match the request')
  if (conditional !== (intent.conditional ? 1 : 0)) fail('the TP/SL is missing')
  if (cancels.size > 0) fail('the TP/SL cancel is missing')
  return { subaccount }
}
