import {
  OrderFlags,
  SelfTradeBehavior,
  Side,
  baseLots,
  getPlaceMarketOrderEncoder,
  quoteLots,
  ticks,
} from '@ellipsis-labs/rise'
import { AccountRole, address } from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PHOENIX_PROGRAM } from './rise'

/** Test data for the trade tools. Not exported from the package. */

export const WALLET = address('DuyJffWSmNtaauW2UDiULLUeT1J57UQWphUoZCwvvDdm')
export const OTHER = address('2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC')

/**
 * A real `PlaceMarketOrder` built by Rise 0.5.38 on 2026-10-08: sell 0.03 SOL
 * (3 lots) with a $100.50 limit (10050 ticks), all-or-nothing, expiring at
 * slot 123, reduce-only.
 */
export const MARKET_ORDER_DATA = Uint8Array.from(
  Buffer.from(
    '5a76c0fcc0632791' +
      '020101422700000000000003000000000000000003000000000000000100000000000000000000000000000000000000000000000000017b000000000000008000',
    'hex',
  ),
)

type OrderFields = {
  buy?: boolean
  priceInTicks?: bigint | null
  lots?: bigint
  minLots?: bigint
  lastValidSlot?: bigint | null
  reduceOnly?: boolean
}

/** Market order data encoded by Rise: by default buy 10 lots, partial fills. */
export function marketOrderData(fields: OrderFields = {}) {
  const {
    buy = true,
    priceInTicks = 11573n,
    lots = 10n,
    minLots = 1n,
    lastValidSlot = 1_000n,
    reduceOnly = false,
  } = fields
  return Uint8Array.from(
    getPlaceMarketOrderEncoder().encode({
      side: buy ? Side.Bid : Side.Ask,
      priceInTicks: priceInTicks === null ? null : ticks(priceInTicks),
      numBaseLots: baseLots(lots),
      numQuoteLots: null,
      minBaseLotsToFill: baseLots(minLots),
      minQuoteLotsToFill: quoteLots(1n),
      selfTradeBehavior: SelfTradeBehavior.Abort,
      matchLimit: null,
      clientOrderId: 0n,
      lastValidSlot,
      orderFlags: reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None,
      cancelExisting: false,
    }),
  )
}

/** A Phoenix instruction the wallet signs, with the given data. */
export function phoenixInstruction(
  data: Uint8Array = new Uint8Array(8),
  {
    program = PHOENIX_PROGRAM,
    signers = [WALLET],
  }: { program?: Address; signers?: readonly Address[] } = {},
): Instruction {
  return {
    programAddress: program,
    accounts: [
      { address: PHOENIX_PROGRAM, role: AccountRole.READONLY },
      ...signers.map((signer) => ({
        address: signer,
        role: AccountRole.WRITABLE_SIGNER,
      })),
    ],
    data,
  }
}
