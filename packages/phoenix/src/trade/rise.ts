import {
  DISCRIMINANTS,
  Direction,
  EMBER_PROGRAM_ADDRESS,
  EMBER_STATE_ADDRESS,
  OrderFlags,
  PHOENIX_GLOBAL_CONFIGURATION_ADDRESS,
  PHOENIX_LOG_AUTHORITY_ADDRESS,
  PHOENIX_PROGRAM_ADDRESS,
  PhoenixHttpClient,
  PhoenixHttpError,
  SYSTEM_PROGRAM_ADDRESS,
  SelfTradeBehavior,
  Side,
  StopLossOrderKind,
  USDC_MINT_ADDRESS,
  attributedNativeSolDepositLamports,
  baseLots,
  buildCancelAllIxResolved,
  buildCancelOrdersByIdIxResolved,
  buildDepositIxsResolved,
  buildPlaceLimitOrderIxResolved,
  buildPlaceMarketOrderIxResolved,
  buildPlacePostOnlyOrderIxResolved,
  buildReallocTraderIx,
  buildReferralActivationTransaction,
  buildSyncParentToChildIxResolved,
  buildTransferCollateralChildToParentIxResolved,
  buildTransferCollateralIxResolved,
  buildTransferNativeSolFromChildToParentIx,
  buildSyncNativeIx,
  buildTransferSolIx,
  buildWithdrawIxsResolved,
  buildWithdrawNativeSolIx,
  decodeConditionalOrderCollection,
  decodeTrader,
  encodeTransferNativeSol,
  encodeSyncNative,
  encodeSystemTransferSol,
  encodeWithdrawNativeSol,
  getEmberVaultAddress,
  getCancelAllEncoder,
  getCancelConditionalOrderDecoder,
  getCancelOrdersByIdEncoder,
  getCreateConditionalOrdersAccountDecoder,
  getDepositFundsDecoder,
  getEmberDepositDecoder,
  getEmberWithdrawDecoder,
  getOnboardTraderDelegatedEncoder,
  getPhoenixConditionalOrdersAddress,
  getPhoenixSplineCollectionAddress,
  getPhoenixTraderSubaccountAddress,
  getPhoenixTraderTokenAccountAddress,
  getPlaceLimitOrderDecoder,
  getPlaceLimitOrderEncoder,
  getPlaceMarketOrderDecoder,
  getPlaceMarketOrderEncoder,
  getPlacePostOnlyOrderDecoder,
  getPlacePositionConditionalOrderDecoder,
  getPlacePostOnlyOrderEncoder,
  getRegisterTraderInstructionDecoder,
  getTransferCollateralDecoder,
  getWithdrawFundsDecoder,
  hasReferralActivationCapabilities,
  nativeSolCollateralHeadroomLamports,
  nativeSolUnaccountedLamports,
  nativeSolSyncDeltaLamports,
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
  PlaceIsolatedLimitOrderRequest,
  PlaceIsolatedMarketOrderRequest,
  PlacePositionConditionalOrderRequest,
  TraderAddress,
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
export const SYSTEM_PROGRAM = address(SYSTEM_PROGRAM_ADDRESS)

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

/**
 * One of the wallet's trader accounts: subaccount 0 is cross margin, the
 * others each hold one isolated position.
 */
export async function traderAccountAddress(
  wallet: Address,
  subaccount = 0,
): Promise<Address> {
  return address(
    await getPhoenixTraderSubaccountAddress({
      authority: brand<Authority>(wallet),
      traderPdaIndex: 0,
      subaccountIndex: subaccount,
      phoenixProgramAddress: PHOENIX_PROGRAM_ADDRESS,
    }),
  )
}

const riseTraderAccount = async (wallet: Address) =>
  brand<TraderAddress>(await traderAccountAddress(wallet))

/** The account holding a trader account's TP/SL orders. */
export async function conditionalOrdersAddress(traderAccount: Address) {
  return address(
    await getPhoenixConditionalOrdersAddress({
      traderAccount: brand<TraderAddress>(traderAccount),
      phoenixProgramAddress: PHOENIX_PROGRAM_ADDRESS,
    }),
  )
}

/** A wallet can hold this many isolated subaccounts. */
export { MAX_SUBACCOUNTS } from '@ellipsis-labs/rise'

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
  return hasReferralActivationCapabilities(readTrader(data).state.flags)
    ? 'activated'
    : 'registered'
}

function readTrader(data: Uint8Array) {
  try {
    return decodeTrader(data)
  } catch {
    throw new PhoenixError(
      'upstream_error',
      'Could not read the Phoenix trader account',
    )
  }
}

/**
 * A trader account's position in one market, in base lots (negative for a
 * short), read from its on-chain data.
 */
export function positionLots(data: Uint8Array, assetId: number) {
  const entry = readTrader(data).positions.entries.find(
    (position) => position.key === BigInt(assetId),
  )
  return entry ? BigInt(entry.value.baseLotPosition) : 0n
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

/** Phoenix's caps on SOL collateral, from `/v1/collateral/assets`. */
export type SolCaps = {
  maxPerTraderBalance: bigint
  maxGlobalBalance: bigint
  currGlobalBalance: bigint
}

/** Where a trader account's SOL collateral stands before a deposit. */
export type SolDepositRoom = {
  caps: SolCaps
  /** Lamports already counted as collateral. */
  accountedLamports: bigint
  /** The trader's own cap: `maxBalance` in trader state. */
  traderMaxLamports: bigint
  /** All lamports in the trader account, rent included. */
  accountLamports: bigint
  /** The rent floor for the trader account's own data length. */
  rentExemptLamports: bigint
}

const solRoomParams = (room: SolDepositRoom) => ({
  metadata: room.caps,
  traderNativeSolLamports: room.accountedLamports,
  traderMaxBalanceLamports: room.traderMaxLamports,
  traderSyncDeltaLamports: nativeSolSyncDeltaLamports({
    accountBalanceLamports: room.accountLamports,
    accountedLamports: room.accountedLamports,
    rentExemptMinimumLamports: room.rentExemptLamports,
  }),
})

/**
 * The most a SOL deposit can be before some of it lands uncounted:
 * `SyncNative` clamps to Phoenix's caps instead of failing.
 */
export const solDepositHeadroom = (room: SolDepositRoom) =>
  nativeSolCollateralHeadroomLamports(solRoomParams(room))

/** How much of a deposit within the headroom Phoenix will count. */
export const solDepositCredit = (room: SolDepositRoom, lamports: bigint) =>
  attributedNativeSolDepositLamports({
    ...solRoomParams(room),
    depositLamports: lamports,
  })

/** SOL in the trader account that Phoenix has not counted yet. */
export const solUncounted = (room: SolDepositRoom) =>
  nativeSolUnaccountedLamports({
    accountBalanceLamports: room.accountLamports,
    accountedLamports: room.accountedLamports,
    rentExemptMinimumLamports: room.rentExemptLamports,
  })

/**
 * The accounts the checks compare, by their place in Rise's builders and
 * Phoenix's server answers. If an upgrade moves them, the checks fail and
 * nothing gets signed.
 */
export const ACCOUNT_AT = {
  order: { traderAccount: 4 },
  placeConditional: { traderAccount: 4, conditionalOrders: 11 },
  cancelConditional: { traderAccount: 3, market: 5, conditionalOrders: 6 },
  /** USDC and SOL transfers and sweeps between cross and a subaccount. */
  collateralMove: { source: 4, destination: 5 },
  realloc: { payer: 3, trader: 4, traderAccount: 5 },
  transfer: { source: 0, destination: 1 },
  sync: { traderAccount: 3 },
  withdraw: { trader: 3, traderAccount: 4, destination: 6 },
} as const

/** The exact data of each SOL collateral instruction, from Rise's encoders. */
export const solData = {
  realloc: () => Uint8Array.from(DISCRIMINANTS.REALLOC_TRADER ?? []),
  transfer: (lamports: bigint) =>
    Uint8Array.from(encodeSystemTransferSol(lamports)),
  sync: () => Uint8Array.from(encodeSyncNative()),
  withdraw: (lamports: bigint) =>
    Uint8Array.from(
      encodeWithdrawNativeSol({ kind: 'withoutExcess', lamports }),
    ),
  /** Phoenix's `TransferNativeSol`, from cross to a subaccount. */
  toSubaccount: (lamports: bigint) =>
    Uint8Array.from(encodeTransferNativeSol(lamports)),
}

function solContext(wallet: Address, keys: ExchangeKeys) {
  const exchange = exchangeAccounts(keys)
  return {
    addresses: {
      phoenixProgramAddress: exchange.phoenixProgramAddress,
      logAuthorityAddress: exchange.logAuthorityAddress,
      globalConfigurationAddress: exchange.globalConfigurationAddress,
    },
    indexes: {
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
    },
    exchange,
    authority: brand<Authority>(wallet),
  }
}

/**
 * Deposit `lamports` of the wallet's SOL into its cross-margin account:
 * reserve the account's SOL slot (any new rent is paid apart from the deposit),
 * move the lamports in, then have Phoenix count them. The same three steps as
 * Rise's `buildNativeSolDepositFlow`, which needs an RPC-backed client where
 * we already hold the resolved accounts.
 */
export async function solDepositInstructions(
  wallet: Address,
  keys: ExchangeKeys,
  lamports: bigint,
) {
  const { addresses, indexes, authority } = solContext(wallet, keys)
  const traderAccount = await riseTraderAccount(wallet)
  return [
    buildReallocTraderIx({
      ...addresses,
      payer: authority,
      trader: authority,
      traderAccount,
    }),
    buildTransferSolIx({
      source: authority,
      destination: traderAccount,
      lamports,
    }),
    buildSyncNativeIx({ ...addresses, ...indexes, traderAccount }),
  ].map(toInstruction)
}

/**
 * Withdraw `lamports` of counted SOL collateral to the wallet. `withoutExcess`
 * never touches lamports Phoenix has not counted. Never queued: it clears now
 * or fails.
 */
export async function solWithdrawInstruction(
  wallet: Address,
  keys: ExchangeKeys,
  lamports: bigint,
) {
  const { addresses, indexes, exchange, authority } = solContext(wallet, keys)
  return toInstruction(
    buildWithdrawNativeSolIx({
      ...addresses,
      ...indexes,
      trader: authority,
      traderAccount: await riseTraderAccount(wallet),
      perpAssetMap: exchange.perpAssetMap,
      destination: wallet,
      withdrawQueue: exchange.withdrawQueue,
      action: { kind: 'withoutExcess', lamports },
    }),
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

/** The exchange accounts every order and collateral move names. */
function tradingAccounts(keys: ExchangeKeys) {
  const exchange = exchangeAccounts(keys)
  return {
    phoenixProgramAddress: exchange.phoenixProgramAddress,
    logAuthorityAddress: exchange.logAuthorityAddress,
    globalConfigurationAddress: exchange.globalConfigurationAddress,
    perpAssetMap: exchange.perpAssetMap,
    globalTraderIndex: exchange.globalTraderIndex,
    activeTraderBuffer: exchange.activeTraderBuffer,
  }
}

async function orderContext(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
  subaccount: number,
) {
  const marketAddress = brand<MarketAddress>(market.marketPubkey)
  const [splineCollection, traderAccount] = await Promise.all([
    getPhoenixSplineCollectionAddress(marketAddress, PHOENIX_PROGRAM_ADDRESS),
    traderAccountAddress(wallet, subaccount),
  ])
  // The spline account derives from the market; Phoenix's API must agree.
  if (splineCollection !== market.splinePubkey)
    throw new PhoenixError(
      'check_failed',
      "Phoenix's market accounts do not match the pinned Rise SDK; nothing was built",
    )
  return {
    exchange: tradingAccounts(keys),
    market: { marketAddress, splineCollection },
    trader: {
      authority: brand<Authority>(wallet),
      traderAccount: brand<TraderAddress>(traderAccount),
    },
  }
}

/** Market orders may fill partly, down to one lot (D4). */
export const MIN_FILL_LOTS = 1n

/**
 * Everything an order states. The builders and the safety check both work
 * from it, so the check compares the instruction with exactly this.
 */
export type OrderSpec = {
  kind: OrderKind
  side: 'buy' | 'sell'
  priceInTicks: bigint
  numBaseLots: bigint
  reduceOnly: boolean
  /** Market orders expire here (D2); resting orders have no expiry. */
  lastValidSlot: bigint | null
}

const flagsFor = (spec: OrderSpec) =>
  spec.reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None
const riseSide = (spec: OrderSpec) =>
  spec.side === 'buy' ? Side.Bid : Side.Ask

/**
 * Immediate-or-cancel with a price limit: partial fills down to one lot,
 * self-trades abort, as in Rise's market orders.
 */
function marketPacket(spec: OrderSpec) {
  return {
    side: riseSide(spec),
    priceInTicks: ticks(spec.priceInTicks),
    numBaseLots: baseLots(spec.numBaseLots),
    numQuoteLots: null,
    minBaseLotsToFill: baseLots(MIN_FILL_LOTS),
    minQuoteLotsToFill: quoteLots(1n),
    selfTradeBehavior: SelfTradeBehavior.Abort,
    matchLimit: null,
    clientOrderId: 0n,
    lastValidSlot: spec.lastValidSlot,
    orderFlags: flagsFor(spec),
    cancelExisting: false,
  }
}

/** A resting limit order: self-trades cancel the resting order, as in Rise. */
function limitPacket(spec: OrderSpec) {
  return {
    side: riseSide(spec),
    priceInTicks: ticks(spec.priceInTicks),
    numBaseLots: baseLots(spec.numBaseLots),
    selfTradeBehavior: SelfTradeBehavior.CancelProvide,
    matchLimit: null,
    clientOrderId: 0n,
    lastValidSlot: spec.lastValidSlot,
    orderFlags: flagsFor(spec),
    cancelExisting: false,
  }
}

/** Post-only never slides: one that would cross the book fails instead. */
function postOnlyPacket(spec: OrderSpec) {
  return {
    side: riseSide(spec),
    priceInTicks: ticks(spec.priceInTicks),
    numBaseLots: baseLots(spec.numBaseLots),
    clientOrderId: 0n,
    slide: false,
    lastValidSlot: spec.lastValidSlot,
    orderFlags: flagsFor(spec),
    cancelExisting: false,
  }
}

/** The exact instruction data an order spec encodes to. */
export function orderData(spec: OrderSpec) {
  switch (spec.kind) {
    case 'market':
      return Uint8Array.from(
        getPlaceMarketOrderEncoder().encode(marketPacket(spec)),
      )
    case 'limit':
      return Uint8Array.from(
        getPlaceLimitOrderEncoder().encode(limitPacket(spec)),
      )
    case 'post_only':
      return Uint8Array.from(
        getPlacePostOnlyOrderEncoder().encode(postOnlyPacket(spec)),
      )
  }
}

/** What `decodeOrder` should read back from an order built from `spec`. */
export function expectedPacket(spec: OrderSpec): OrderPacket {
  return {
    ...spec,
    minBaseLotsToFill: spec.kind === 'market' ? MIN_FILL_LOTS : null,
    slide: false,
    cancelExisting: false,
  }
}

/** The order instruction for `spec`, from Rise's resolved builders. */
export async function orderInstruction(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
  spec: OrderSpec,
  subaccount = 0,
) {
  const context = await orderContext(wallet, keys, market, subaccount)
  switch (spec.kind) {
    case 'market':
      return toInstruction(
        buildPlaceMarketOrderIxResolved({
          ...context,
          orderPacket: marketPacket(spec),
        }),
      )
    case 'limit':
      return toInstruction(
        buildPlaceLimitOrderIxResolved({
          ...context,
          orderPacket: limitPacket(spec),
        }),
      )
    case 'post_only':
      return toInstruction(
        buildPlacePostOnlyOrderIxResolved({
          ...context,
          orderPacket: postOnlyPacket(spec),
        }),
      )
  }
}

function amountOf(decode: () => bigint | null) {
  try {
    return decode()
  } catch {
    return null
  }
}

/** The amounts in collateral instructions, or null when data is not one. */
export const collateralAmounts = {
  depositFunds: (data: Uint8Array) =>
    amountOf(() => getDepositFundsDecoder().decode(data)),
  withdrawFunds: (data: Uint8Array) =>
    amountOf(() => getWithdrawFundsDecoder().decode(data)),
  emberDeposit: (data: Uint8Array) =>
    amountOf(() => getEmberDepositDecoder().decode(data)),
  emberWithdraw: (data: Uint8Array) =>
    amountOf(() => getEmberWithdrawDecoder().decode(data)),
}

/** Ember's state account, the delegate a withdrawal approves. */
export const EMBER_STATE = address(EMBER_STATE_ADDRESS)

/** One resting order to cancel, as Phoenix's trader state names it. */
export type CancelTarget = { priceInTicks: bigint; orderSequenceNumber: bigint }

/** Phoenix cancels at most this many orders by ID in one instruction. */
export const MAX_CANCEL_IDS = 100

const cancelIds = (targets: readonly CancelTarget[]) =>
  targets.map((target) => ({
    nodePointer: null,
    orderId: {
      priceInTicks: ticks(target.priceInTicks),
      orderSequenceNumber: target.orderSequenceNumber,
    },
  }))

/**
 * The exact instruction data of a cancel: these orders by ID, or every
 * order the account has in the market when `targets` is null.
 */
export function cancelData(targets: readonly CancelTarget[] | null) {
  return Uint8Array.from(
    targets === null
      ? getCancelAllEncoder().encode(undefined)
      : getCancelOrdersByIdEncoder().encode({ orderIds: cancelIds(targets) }),
  )
}

/** Everything Rise's parent and child builders name for one subaccount. */
async function isolatedAccounts(
  wallet: Address,
  keys: ExchangeKeys,
  subaccount: number,
) {
  const [parentTraderAccount, childTraderAccount] = await Promise.all([
    traderAccountAddress(wallet),
    traderAccountAddress(wallet, subaccount),
  ])
  return {
    exchange: tradingAccounts(keys),
    authority: brand<Authority>(wallet),
    parentTraderAccount: brand<TraderAddress>(parentTraderAccount),
    childTraderAccount: brand<TraderAddress>(childTraderAccount),
  }
}

/**
 * Move `amount` USDC base units from cross into an isolated subaccount: sync
 * the child with its parent, then transfer, in the order Rise's flows use.
 */
export async function addMarginInstructions(
  wallet: Address,
  keys: ExchangeKeys,
  subaccount: number,
  amount: bigint,
) {
  const { exchange, authority, parentTraderAccount, childTraderAccount } =
    await isolatedAccounts(wallet, keys, subaccount)
  return [
    buildSyncParentToChildIxResolved({
      exchange,
      trader: { authority, parentTraderAccount, childTraderAccount },
    }),
    buildTransferCollateralIxResolved({
      exchange,
      trader: {
        authority,
        srcTraderAccount: parentTraderAccount,
        dstTraderAccount: childTraderAccount,
      },
      amount,
    }),
  ].map(toInstruction)
}

/**
 * Return an emptied isolated subaccount's USDC and native SOL to cross. Both
 * are silent no-ops on-chain while the subaccount holds an order or position.
 */
export async function sweepInstructions(
  wallet: Address,
  keys: ExchangeKeys,
  subaccount: number,
) {
  const { exchange, authority, parentTraderAccount, childTraderAccount } =
    await isolatedAccounts(wallet, keys, subaccount)
  return [
    buildTransferCollateralChildToParentIxResolved({
      exchange,
      trader: { authority, childTraderAccount, parentTraderAccount },
    }),
    buildTransferNativeSolFromChildToParentIx({
      trader: authority,
      childTraderAccount,
      parentTraderAccount,
      perpAssetMap: exchange.perpAssetMap,
      globalTraderIndex: exchange.globalTraderIndex,
      activeTraderBuffer: exchange.activeTraderBuffer,
    }),
  ].map(toInstruction)
}

/** The cancel instruction, from Rise's resolved builders. */
export async function cancelInstruction(
  wallet: Address,
  keys: ExchangeKeys,
  market: OrderMarket,
  targets: readonly CancelTarget[] | null,
  subaccount = 0,
) {
  const context = await orderContext(wallet, keys, market, subaccount)
  return toInstruction(
    targets === null
      ? buildCancelAllIxResolved(context)
      : buildCancelOrdersByIdIxResolved({
          ...context,
          orderIds: cancelIds(targets),
        }),
  )
}

/**
 * Phoenix's own server-built routes, through Rise's HTTP client. Phoenix's
 * server picks the isolated subaccount and orders the steps. Its answer is
 * untrusted: every tool passes it through `checkPhoenixBundle` before use.
 */
export type PhoenixOrders = {
  placeIsolatedMarketOrder: (
    request: PlaceIsolatedMarketOrderRequest,
  ) => Promise<Instruction[]>
  placeIsolatedLimitOrder: (
    request: PlaceIsolatedLimitOrderRequest,
  ) => Promise<Instruction[]>
  placePositionConditionalOrder: (
    request: PlacePositionConditionalOrderRequest,
  ) => Promise<Instruction[]>
  cancelConditionalOrder: (
    request: Parameters<
      ReturnType<PhoenixHttpClient['orders']>['cancelConditionalOrder']
    >[0],
  ) => Promise<Instruction[]>
}

function riseError(error: unknown) {
  if (error instanceof PhoenixHttpError) {
    if (error.status === 400)
      return new PhoenixError('invalid_input', 'Phoenix rejected the request')
    if (error.status === 404)
      return new PhoenixError('not_found', 'Phoenix has no such record')
    if (error.status === 429)
      return new PhoenixError(
        'rate_limited',
        'Phoenix is rate limiting requests',
      )
    return new PhoenixError(
      'upstream_error',
      `Phoenix answered HTTP ${error.status}`,
    )
  }
  if (error instanceof Error && error.name === 'AbortError')
    return new PhoenixError('timeout', 'Phoenix did not answer in time')
  return new PhoenixError('upstream_error', 'Could not reach Phoenix')
}

export function createPhoenixOrders({
  baseURL,
  timeoutMs,
}: { baseURL?: string; timeoutMs?: number } = {}): PhoenixOrders {
  const orders = new PhoenixHttpClient({
    ...(baseURL ? { apiUrl: baseURL } : {}),
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  }).orders()
  const call = async (request: Promise<readonly RiseInstruction[]>) => {
    try {
      return (await request).map(toInstruction)
    } catch (error) {
      throw riseError(error)
    }
  }
  return {
    placeIsolatedMarketOrder: (request) =>
      call(orders.placeIsolatedMarketOrder(request)),
    placeIsolatedLimitOrder: (request) =>
      call(orders.placeIsolatedLimitOrder(request)),
    placePositionConditionalOrder: (request) =>
      call(orders.placePositionConditionalOrder(request)),
    cancelConditionalOrder: (request) =>
      call(orders.cancelConditionalOrder(request)),
  }
}

/** One TP or SL leg, as a position conditional order states it. */
export type TriggerPacket = {
  triggerDirection: 'greater' | 'less'
  /** The side of the order that fires. */
  side: 'buy' | 'sell'
  orderKind: 'ioc' | 'limit'
  triggerPriceInTicks: bigint
  executionPriceInTicks: bigint
}

export type ConditionalPacket = {
  assetId: number
  greater: TriggerPacket | null
  less: TriggerPacket | null
  sizeBaseLots: bigint | null
  sizePercent: number | null
}

/** One instruction of a server-built Phoenix transaction, decoded. */
export type BundleStep =
  | {
      kind: 'register'
      subaccount: number
      traderPdaIndex: number
      maxPositions: bigint
      traderPreferenceBits: number
    }
  | { kind: 'realloc' | 'sync' | 'sweep_usdc' | 'sweep_sol' }
  | { kind: 'transfer_usdc'; amount: bigint }
  | { kind: 'transfer_sol' }
  | { kind: 'order'; packet: OrderPacket }
  | { kind: 'create_conditional'; capacity: number }
  | { kind: 'place_conditional'; packet: ConditionalPacket }
  | {
      kind: 'cancel_conditional'
      index: number
      disableFirst: boolean
      disableSecond: boolean
    }

/** A slot of a trader account's TP/SL account, with its live legs only. */
export type ConditionalSlot = ConditionalPacket & {
  /** The index a cancel names: 1 to 191, as Phoenix reserves slot 0. */
  slot: number
}

/** A Rise request's trigger: `greaterTrigger` or `lessTrigger`. */
export type TriggerRequest = NonNullable<
  PlacePositionConditionalOrderRequest['greaterTrigger']
>

const startsWith = (data: Uint8Array, prefix: Uint8Array | undefined) =>
  prefix !== undefined &&
  data.length >= prefix.length &&
  prefix.every((byte, index) => data[index] === byte)

const DIRECTIONS: Partial<Record<number, TriggerPacket['triggerDirection']>> = {
  [Direction.GreaterThan]: 'greater',
  [Direction.LessThan]: 'less',
}
const TRIGGER_KINDS: Partial<Record<number, TriggerPacket['orderKind']>> = {
  [StopLossOrderKind.IOC]: 'ioc',
  [StopLossOrderKind.Limit]: 'limit',
}

function triggerPacket(
  trigger: {
    triggerDirection: number
    tradeSide: Side
    orderKind: number
    triggerPrice: bigint
    executionPrice: bigint
  } | null,
): TriggerPacket | null {
  if (!trigger) return null
  const triggerDirection = DIRECTIONS[trigger.triggerDirection]
  const orderKind = TRIGGER_KINDS[trigger.orderKind]
  if (!triggerDirection || !orderKind)
    throw new PhoenixError(
      'check_failed',
      'A TP/SL leg has a direction or order kind the pinned Rise SDK does not know; nothing was signed',
    )
  return {
    triggerDirection,
    side: sideOf(trigger.tradeSide),
    orderKind,
    triggerPriceInTicks: trigger.triggerPrice,
    executionPriceInTicks: trigger.executionPrice,
  }
}

type CollectionOrder = ReturnType<
  typeof decodeConditionalOrderCollection
>['orders'][number]

function liveLeg(
  leg: CollectionOrder['greaterTriggerOrder'],
  direction: Direction,
): TriggerPacket | null {
  if (!leg.isActive) return null
  if (leg.executionDirection !== direction)
    throw new PhoenixError(
      'check_failed',
      'A TP/SL leg in the account fires the wrong way for its place; nothing was built',
    )
  return triggerPacket({
    ...leg,
    triggerDirection: leg.executionDirection,
  })
}

/**
 * The live slots of a TP/SL account, read from its on-chain data. One slot
 * holds a greater and a less leg that share one size. A cancelled slot stays
 * in the account inactive, so only active legs come back.
 */
export function conditionalSlots(
  data: Uint8Array,
  traderAccount: Address,
): ConditionalSlot[] {
  const collection = tryDecode(() => decodeConditionalOrderCollection(data))
  if (!collection)
    throw new PhoenixError(
      'upstream_error',
      'Could not read the Phoenix TP/SL account',
    )
  if (collection.header.traderKey !== traderAccount)
    throw new PhoenixError(
      'check_failed',
      'The Phoenix TP/SL account belongs to another trader; nothing was built',
    )
  return collection.activeOrderIndices.flatMap((slot) => {
    const order = collection.orders[slot]
    if (!order) return []
    return [
      {
        slot,
        assetId: order.assetId,
        greater: liveLeg(order.greaterTriggerOrder, Direction.GreaterThan),
        less: liveLeg(order.lessTriggerOrder, Direction.LessThan),
        sizeBaseLots: order.usePercent ? null : order.maxSize,
        sizePercent: order.usePercent ? order.percent : null,
      },
    ]
  })
}

/** Reads one Phoenix instruction, or returns null when it is no known step. */
export function decodeBundleStep(data: Uint8Array): BundleStep | null {
  const decode = <T>(read: () => T, step: (value: T) => BundleStep) => {
    const value = tryDecode(read)
    return value === null ? null : step(value)
  }
  if (startsWith(data, DISCRIMINANTS.REGISTER_TRADER))
    return decode(
      () => getRegisterTraderInstructionDecoder().decode(data),
      (params) => ({
        kind: 'register',
        subaccount: params.subaccountIndex,
        traderPdaIndex: params.traderPdaIndex,
        maxPositions: params.maxPositions,
        traderPreferenceBits: params.traderPreferenceBits ?? 0,
      }),
    )
  if (startsWith(data, DISCRIMINANTS.REALLOC_TRADER)) return { kind: 'realloc' }
  if (startsWith(data, DISCRIMINANTS.SYNC_PARENT_TO_CHILD))
    return { kind: 'sync' }
  if (startsWith(data, DISCRIMINANTS.TRANSFER_COLLATERAL_CHILD_TO_PARENT))
    return { kind: 'sweep_usdc' }
  if (startsWith(data, DISCRIMINANTS.TRANSFER_NATIVE_SOL_FROM_CHILD_TO_PARENT))
    return { kind: 'sweep_sol' }
  if (startsWith(data, DISCRIMINANTS.TRANSFER_COLLATERAL))
    return decode(
      () => getTransferCollateralDecoder().decode(data),
      (amount) => ({ kind: 'transfer_usdc', amount }),
    )
  if (startsWith(data, DISCRIMINANTS.TRANSFER_NATIVE_SOL))
    return { kind: 'transfer_sol' }
  if (startsWith(data, DISCRIMINANTS.CREATE_CONDITIONAL_ORDERS_ACCOUNT))
    return decode(
      () => getCreateConditionalOrdersAccountDecoder().decode(data),
      (capacity) => ({ kind: 'create_conditional', capacity }),
    )
  if (startsWith(data, DISCRIMINANTS.PLACE_POSITION_CONDITIONAL_ORDER))
    return decode(
      () => getPlacePositionConditionalOrderDecoder().decode(data),
      (order) => ({
        kind: 'place_conditional',
        packet: {
          assetId: order.assetId,
          greater: triggerPacket(order.greaterTriggerOrder),
          less: triggerPacket(order.lessTriggerOrder),
          sizeBaseLots: order.sizeBaseLots,
          sizePercent: order.sizePercent,
        },
      }),
    )
  if (startsWith(data, DISCRIMINANTS.CANCEL_CONDITIONAL_ORDER))
    return decode(
      () => getCancelConditionalOrderDecoder().decode(data),
      (cancel) => ({
        kind: 'cancel_conditional',
        index: cancel.conditionalOrderIndex,
        disableFirst: cancel.disableFirst,
        disableSecond: cancel.disableSecond,
      }),
    )
  const packet = decodeOrder(data)
  return packet ? { kind: 'order', packet } : null
}

/** Whether any of `instructions` is a Phoenix step of this kind. */
export const hasStep = (
  instructions: readonly Instruction[],
  kind: BundleStep['kind'],
) =>
  instructions.some(
    ({ data }) => decodeBundleStep(Uint8Array.from(data ?? []))?.kind === kind,
  )
