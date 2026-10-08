import {
  EMBER_PROGRAM_ADDRESS,
  OrderFlags,
  PHOENIX_PROGRAM_ADDRESS,
  Side,
  getPlaceMarketOrderDecoder,
} from '@ellipsis-labs/rise'
import { AccountRole, address } from '@solana/kit'
import type { Instruction } from '@solana/kit'
import { PhoenixError } from '../client'

/**
 * The only file that imports Rise (`@ellipsis-labs/rise`), Ellipsis Labs'
 * Phoenix SDK. Rise is 0.x and pinned to an exact version; it builds on
 * `@solana/kit` 4 while this package uses kit 6, so everything Rise returns
 * crosses into kit 6 types here, checked at runtime.
 */

export const PHOENIX_PROGRAM = address(PHOENIX_PROGRAM_ADDRESS)
export const EMBER_PROGRAM = address(EMBER_PROGRAM_ADDRESS)

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
