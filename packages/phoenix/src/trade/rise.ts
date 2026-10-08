import {
  EMBER_PROGRAM_ADDRESS,
  EMBER_STATE_ADDRESS,
  OrderFlags,
  PHOENIX_GLOBAL_CONFIGURATION_ADDRESS,
  PHOENIX_LOG_AUTHORITY_ADDRESS,
  PHOENIX_PROGRAM_ADDRESS,
  SelfTradeBehavior,
  Side,
  USDC_MINT_ADDRESS,
  baseLots,
  buildDepositIxsResolved,
  buildPlaceLimitOrderIxResolved,
  buildPlaceMarketOrderIxResolved,
  buildPlacePostOnlyOrderIxResolved,
  buildReferralActivationTransaction,
  buildWithdrawIxsResolved,
  decodeTrader,
  getEmberVaultAddress,
  getOnboardTraderDelegatedEncoder,
  getPhoenixSplineCollectionAddress,
  getPhoenixTraderSubaccountAddress,
  getPhoenixTraderTokenAccountAddress,
  getPlaceLimitOrderDecoder,
  getPlaceMarketOrderDecoder,
  getPlacePostOnlyOrderDecoder,
  getRegisterTraderInstructionDecoder,
  hasReferralActivationCapabilities,
  quoteLots,
  ticks,
} from '@ellipsis-labs/rise'
import type {
  ActiveTraderBufferAddressArray,
  ActiveTraderBufferArenaAddress,
  ActiveTraderBufferHeaderAddress,
  Authority,
  GlobalTraderIndexAddressArray,
  GlobalTraderIndexArenaAddress,
  GlobalTraderIndexHeaderAddress,
  GlobalVaultAddress,
  MarketAddress,
  MintAddress,
  PerpAssetMapAddress,
  WithdrawQueueAddress,
} from '@ellipsis-labs/rise'
import { AccountRole, address } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import type { ExchangeKeys } from './schemas'

/**
 * The only file that imports Rise (`@ellipsis-labs/rise`), Ellipsis Labs'
 * Phoenix SDK. Rise is 0.x and pinned to an exact version; it builds on
 * `@solana/kit` 4 while this package uses kit 6, so everything Rise returns
 * crosses into kit 6 types here, checked at runtime.
 */

export const PHOENIX_PROGRAM = address(PHOENIX_PROGRAM_ADDRESS)
export const EMBER_PROGRAM = address(EMBER_PROGRAM_ADDRESS)
export const USDC_MINT = address(USDC_MINT_ADDRESS)

/**
 * Rise brands each kind of address with a private symbol and exports no way
 * to make one, so this is the one place we assert the brand. Every value is
 * a validated address before it gets here.
 */
function brand<T extends string>(value: string): T {
  return address(value) as string as T
}

/** The shape of a Rise (kit 4) instruction, without its branded types. */
export type RiseInstruction = {
  programAddress: string
  accounts?: ReadonlyArray<{ address: string; role: number }>
  data?: ArrayLike<number>
}

const ROLES = [
  AccountRole.READONLY,
  AccountRole.WRITABLE,
  AccountRole.READONLY_SIGNER,
  AccountRole.WRITABLE_SIGNER,
]

function toRole(role: number) {
  const known = ROLES.find((value) => value === role)
  if (known === undefined)
    throw new PhoenixError(
      'check_failed',
      `Rise returned an unknown account role ${role}`,
    )
  return known
}

/** A Rise instruction as a kit 6 instruction. */
export function toInstruction(instruction: RiseInstruction): Instruction {
  return {
    programAddress: address(instruction.programAddress),
    accounts: (instruction.accounts ?? []).map((account) => ({
      address: address(account.address),
      role: toRole(account.role),
    })),
    data: Uint8Array.from(instruction.data ?? []),
  }
}

export type OrderKind = 'market' | 'limit' | 'post_only'

/** The fields of an order packet that the safety checks compare. */
export type OrderPacket = {
  kind: OrderKind
  side: 'buy' | 'sell'
  /** null means no price limit at all; only market orders can say so. */
  priceInTicks: bigint | null
  numBaseLots: bigint
  /** Market orders only: the least that must fill; null otherwise. */
  minBaseLotsToFill: bigint | null
  lastValidSlot: bigint | null
  reduceOnly: boolean
  /** Post-only orders only: move to the top of the book instead of failing. */
  slide: boolean
  /** Cancel resting orders instead of failing a margin check. */
  cancelExisting: boolean
}

const sideOf = (side: Side) => (side === Side.Bid ? 'buy' : 'sell')
const isReduceOnly = (flags: number) => (flags & OrderFlags.ReduceOnly) !== 0

function tryDecode<T>(decode: () => T) {
  try {
    return decode()
  } catch {
    return null
  }
}

/**
 * Reads a `PlaceMarketOrder`, `PlaceLimitOrder` or `PlacePostOnlyOrder`
 * instruction's data, or returns null when it is none of them. Each decoder
 * checks its own discriminator.
 */
export function decodeOrder(data: Uint8Array): OrderPacket | null {
  const market = tryDecode(() => getPlaceMarketOrderDecoder().decode(data))
  if (market)
    return {
      kind: 'market',
      side: sideOf(market.side),
      priceInTicks: market.priceInTicks,
      numBaseLots: market.numBaseLots,
      minBaseLotsToFill: market.minBaseLotsToFill,
      lastValidSlot: market.lastValidSlot,
      reduceOnly: isReduceOnly(market.orderFlags),
      slide: false,
      cancelExisting: market.cancelExisting,
    }
  const limit = tryDecode(() => getPlaceLimitOrderDecoder().decode(data))
  if (limit)
    return {
      kind: 'limit',
      side: sideOf(limit.side),
      priceInTicks: limit.priceInTicks,
      numBaseLots: limit.numBaseLots,
      minBaseLotsToFill: null,
      lastValidSlot: limit.lastValidSlot,
      reduceOnly: isReduceOnly(limit.orderFlags),
      slide: false,
      cancelExisting: limit.cancelExisting,
    }
  const postOnly = tryDecode(() => getPlacePostOnlyOrderDecoder().decode(data))
  if (postOnly)
    return {
      kind: 'post_only',
      side: sideOf(postOnly.side),
      priceInTicks: postOnly.priceInTicks,
      numBaseLots: postOnly.numBaseLots,
      minBaseLotsToFill: null,
      lastValidSlot: postOnly.lastValidSlot,
      reduceOnly: isReduceOnly(postOnly.orderFlags),
      slide: postOnly.slide,
      cancelExisting: postOnly.cancelExisting,
    }
  return null
}

/** The wallet's default cross-margin trader account (PDA 0, subaccount 0). */
export async function traderAccountAddress(wallet: Address) {
  return address(
    await getPhoenixTraderSubaccountAddress({
      authority: brand<Authority>(wallet),
      traderPdaIndex: 0,
      subaccountIndex: 0,
      phoenixProgramAddress: PHOENIX_PROGRAM_ADDRESS,
    }),
  )
}

/** The wallet's USDC token account, which deposits draw from. */
export async function usdcAccountAddress(wallet: Address) {
  return address(
    await getPhoenixTraderTokenAccountAddress(
      brand<Authority>(wallet),
      USDC_MINT_ADDRESS,
    ),
  )
}

export type Activation = 'missing' | 'registered' | 'activated'

/**
 * Where a trader account stands, from its on-chain data: missing, registered
 * but unable to deposit and trade, or activated.
 */
export function activationOf(data: Uint8Array | null): Activation {
  if (!data || data.length === 0) return 'missing'
  let flags
  try {
    flags = decodeTrader(data).state.flags
  } catch {
    throw new PhoenixError(
      'upstream_error',
      'Could not read the Phoenix trader account',
    )
  }
  return hasReferralActivationCapabilities(flags) ? 'activated' : 'registered'
}

function exchangeAccounts(keys: ExchangeKeys) {
  // Rise's constants are what its encoders were built for; a mismatch means
  // Phoenix moved and the pinned SDK is out of date.
  if (keys.globalConfig !== PHOENIX_GLOBAL_CONFIGURATION_ADDRESS)
    throw new PhoenixError(
      'check_failed',
      "Phoenix's exchange accounts do not match the pinned Rise SDK; nothing was built",
    )
  const [traderIndex, ...traderIndexArenas] = keys.globalTraderIndex
  const [traderBuffer, ...traderBufferArenas] = keys.activeTraderBuffer
  if (traderIndex === undefined || traderBuffer === undefined)
    throw new PhoenixError('upstream_error', 'Phoenix sent no trader index')
  const globalTraderIndex: GlobalTraderIndexAddressArray = [
    brand<GlobalTraderIndexHeaderAddress>(traderIndex),
    ...traderIndexArenas.map((key) =>
      brand<GlobalTraderIndexArenaAddress>(key),
    ),
  ]
  const activeTraderBuffer: ActiveTraderBufferAddressArray = [
    brand<ActiveTraderBufferHeaderAddress>(traderBuffer),
    ...traderBufferArenas.map((key) =>
      brand<ActiveTraderBufferArenaAddress>(key),
    ),
  ]
  return {
    phoenixProgramAddress: PHOENIX_PROGRAM_ADDRESS,
    logAuthorityAddress: PHOENIX_LOG_AUTHORITY_ADDRESS,
    globalConfigurationAddress: PHOENIX_GLOBAL_CONFIGURATION_ADDRESS,
    canonicalMint: brand<MintAddress>(keys.canonicalMint),
    usdcMint: USDC_MINT_ADDRESS,
    perpAssetMap: brand<PerpAssetMapAddress>(keys.perpAssetMap),
    globalVault: brand<GlobalVaultAddress>(keys.globalVault),
    withdrawQueue: brand<WithdrawQueueAddress>(keys.withdrawQueue),
    globalTraderIndex,
    activeTraderBuffer,
    emberState: EMBER_STATE_ADDRESS,
  }
}

async function collateralAccounts(wallet: Address, keys: ExchangeKeys) {
  const exchange = exchangeAccounts(keys)
  const authority = brand<Authority>(wallet)
  const [emberVault, traderAccount, usdcTokenAccount, phoenixTokenAccount] =
    await Promise.all([
      getEmberVaultAddress(PHOENIX_PROGRAM_ADDRESS),
      getPhoenixTraderSubaccountAddress({
        authority,
        traderPdaIndex: 0,
        subaccountIndex: 0,
        phoenixProgramAddress: PHOENIX_PROGRAM_ADDRESS,
      }),
      getPhoenixTraderTokenAccountAddress(authority, USDC_MINT_ADDRESS),
      getPhoenixTraderTokenAccountAddress(authority, exchange.canonicalMint),
    ])
  return {
    exchange: { ...exchange, emberVault },
    trader: { authority, traderAccount, usdcTokenAccount, phoenixTokenAccount },
  }
}

/**
 * Deposit `amount` USDC base units into the wallet's cross-margin account:
 * create its Phoenix USD token account if needed, wrap USDC 1:1 into
 * Phoenix USD (Ember), and deposit it.
 */
export async function depositInstructions(
  wallet: Address,
  keys: ExchangeKeys,
  amount: bigint,
) {
  const accounts = await collateralAccounts(wallet, keys)
  return buildDepositIxsResolved({ ...accounts, amount }).instructions.map(
    toInstruction,
  )
}

/**
 * Withdraw `amount` Phoenix USD base units back to the wallet's USDC through
 * Phoenix's withdraw queue.
 */
export async function withdrawInstructions(
  wallet: Address,
  keys: ExchangeKeys,
  amount: bigint,
) {
  const accounts = await collateralAccounts(wallet, keys)
  return buildWithdrawIxsResolved({ ...accounts, amount }).instructions.map(
    toInstruction,
  )
}

/**
 * The unsigned referral activation transaction, exactly as Phoenix's
 * `/v1/referral/activate-tx` expects it: `RegisterTrader` when the account
 * is missing, then `OnboardTraderDelegated`, which Phoenix's onboarder
 * co-signs. No compute budget instructions: Phoenix validates the shape.
 */
export async function activationTransaction({
  wallet,
  keys,
  onboarder,
  permissionAccount,
  referralCode,
  blockhash,
  lastValidBlockHeight,
  register,
}: {
  wallet: Address
  keys: ExchangeKeys
  onboarder: string
  permissionAccount: string
  referralCode: string
  blockhash: string
  lastValidBlockHeight: bigint
  register: boolean
}) {
  const exchange = exchangeAccounts(keys)
  const build = await buildReferralActivationTransaction({
    referralCode,
    traderAuthority: wallet,
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    permission: {
      trader_onboarder: onboarder,
      permission_account: permissionAccount,
      // Read by the API, not by the transaction builder.
      risk_authority: '',
    },
    exchangeAccounts: {
      phoenixProgramAddress: exchange.phoenixProgramAddress,
      logAuthorityAddress: exchange.logAuthorityAddress,
      globalConfigurationAddress: exchange.globalConfigurationAddress,
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
    },
    traderPdaIndex: 0,
    traderSubaccountIndex: 0,
    includeRegisterTrader: register,
    registerTraderMaxPositions: MAX_POSITIONS,
  })
  return build.unsignedTransactionBase64
}

/** Positions a new cross-margin account can hold; Phoenix's default. */
export const MAX_POSITIONS = 128n

/** `RegisterTrader` instruction data, or null when it is not one. */
export function decodeRegisterTrader(data: Uint8Array) {
  try {
    return getRegisterTraderInstructionDecoder().decode(data)
  } catch {
    return null
  }
}

/** Whether instruction data is `OnboardTraderDelegated` (no arguments). */
export function isOnboardTraderDelegated(data: Uint8Array) {
  const expected = getOnboardTraderDelegatedEncoder().encode(undefined)
  return (
    data.length === expected.length &&
    data.every((byte, index) => byte === expected[index])
  )
}

/** The market accounts an order names, from Phoenix's market config. */
export type OrderMarket = { marketPubkey: string; splinePubkey: string }

async function orderContext(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
) {
  const exchange = exchangeAccounts(keys)
  const marketAddress = brand<MarketAddress>(market.marketPubkey)
  const [splineCollection, traderAccount] = await Promise.all([
    getPhoenixSplineCollectionAddress(marketAddress, PHOENIX_PROGRAM_ADDRESS),
    getPhoenixTraderSubaccountAddress({
      authority: brand<Authority>(wallet),
      traderPdaIndex: 0,
      subaccountIndex: 0,
      phoenixProgramAddress: PHOENIX_PROGRAM_ADDRESS,
    }),
  ])
  // The spline account derives from the market; Phoenix's API must agree.
  if (splineCollection !== market.splinePubkey)
    throw new PhoenixError(
      'check_failed',
      "Phoenix's market accounts do not match the pinned Rise SDK; nothing was built",
    )
  return {
    exchange: {
      phoenixProgramAddress: exchange.phoenixProgramAddress,
      logAuthorityAddress: exchange.logAuthorityAddress,
      globalConfigurationAddress: exchange.globalConfigurationAddress,
      perpAssetMap: exchange.perpAssetMap,
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
    },
    market: { marketAddress, splineCollection },
    trader: { authority: brand<Authority>(wallet), traderAccount },
  }
}

export type OrderRequest = {
  side: 'buy' | 'sell'
  priceInTicks: bigint
  numBaseLots: bigint
  reduceOnly: boolean
}

const flagsFor = (order: OrderRequest) =>
  order.reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None
const riseSide = (order: OrderRequest) =>
  order.side === 'buy' ? Side.Bid : Side.Ask

/**
 * An immediate-or-cancel order with a price limit. Partial fills are
 * allowed (at least one lot); it expires at `lastValidSlot`. Self-trades
 * abort, as Rise's market orders do.
 */
export async function marketOrderInstruction(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
  order: OrderRequest & { lastValidSlot: bigint },
) {
  return toInstruction(
    buildPlaceMarketOrderIxResolved({
      ...(await orderContext(wallet, keys, market)),
      orderPacket: {
        side: riseSide(order),
        priceInTicks: ticks(order.priceInTicks),
        numBaseLots: baseLots(order.numBaseLots),
        numQuoteLots: null,
        minBaseLotsToFill: baseLots(MIN_FILL_LOTS),
        minQuoteLotsToFill: quoteLots(1n),
        selfTradeBehavior: SelfTradeBehavior.Abort,
        matchLimit: null,
        clientOrderId: 0n,
        lastValidSlot: order.lastValidSlot,
        orderFlags: flagsFor(order),
        cancelExisting: false,
      },
    }),
  )
}

/** Market orders may fill partly, down to one lot (D4). */
export const MIN_FILL_LOTS = 1n

/**
 * A resting limit order with no expiry. Post-only orders never slide: one
 * that would cross the book fails instead of moving to a worse price.
 * Self-trades cancel the resting order, as Rise's limit orders do.
 */
export async function limitOrderInstruction(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
  order: OrderRequest & { postOnly: boolean },
) {
  const context = await orderContext(wallet, keys, market)
  const common = {
    side: riseSide(order),
    priceInTicks: ticks(order.priceInTicks),
    numBaseLots: baseLots(order.numBaseLots),
    clientOrderId: 0n,
    lastValidSlot: null,
    orderFlags: flagsFor(order),
    cancelExisting: false,
  }
  return toInstruction(
    order.postOnly
      ? buildPlacePostOnlyOrderIxResolved({
          ...context,
          orderPacket: { ...common, slide: false },
        })
      : buildPlaceLimitOrderIxResolved({
          ...context,
          orderPacket: {
            ...common,
            selfTradeBehavior: SelfTradeBehavior.CancelProvide,
            matchLimit: null,
          },
        }),
  )
}
