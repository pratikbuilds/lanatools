import {
  EMBER_PROGRAM_ADDRESS,
  EMBER_STATE_ADDRESS,
  OrderFlags,
  PHOENIX_GLOBAL_CONFIGURATION_ADDRESS,
  PHOENIX_LOG_AUTHORITY_ADDRESS,
  PHOENIX_PROGRAM_ADDRESS,
  Side,
  USDC_MINT_ADDRESS,
  buildDepositIxsResolved,
  buildReferralActivationTransaction,
  buildWithdrawIxsResolved,
  decodeTrader,
  getEmberVaultAddress,
  getOnboardTraderDelegatedEncoder,
  getPhoenixTraderSubaccountAddress,
  getPhoenixTraderTokenAccountAddress,
  getPlaceMarketOrderDecoder,
  getRegisterTraderInstructionDecoder,
  hasReferralActivationCapabilities,
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

/** The fields of a market order packet that the safety checks compare. */
export type MarketOrderPacket = {
  side: 'buy' | 'sell'
  /** null means no price limit at all. */
  priceInTicks: bigint | null
  numBaseLots: bigint
  minBaseLotsToFill: bigint
  lastValidSlot: bigint | null
  reduceOnly: boolean
}

/**
 * Reads a `PlaceMarketOrder` instruction's data, or returns null when the
 * data is not that instruction.
 */
export function decodeMarketOrder(data: Uint8Array): MarketOrderPacket | null {
  let packet
  try {
    packet = getPlaceMarketOrderDecoder().decode(data)
  } catch {
    return null
  }
  return {
    side: packet.side === Side.Bid ? 'buy' : 'sell',
    priceInTicks: packet.priceInTicks,
    numBaseLots: packet.numBaseLots,
    minBaseLotsToFill: packet.minBaseLotsToFill,
    lastValidSlot: packet.lastValidSlot,
    reduceOnly: (packet.orderFlags & OrderFlags.ReduceOnly) !== 0,
  }
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
