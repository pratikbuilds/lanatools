import { getBase64Encoder, getU64Decoder } from '@solana/kit'
import type { Address } from '@solana/kit'
import { fromLots } from '../units'
import { TOKEN_PROGRAM } from './checks'
import { positionLots, traderAccountAddress } from './rise'
import type { PositionRef } from './tool'
import { rpcTimeout } from './transaction'
import type { TradeRpc } from './transaction'

/**
 * On-chain reads the trade tools need before building. The chain, not
 * Phoenix's API, says whether an account exists and what a wallet holds.
 */

export type ChainAccount = {
  owner: Address
  lamports: bigint
  data: Uint8Array
}

export async function fetchAccount(
  rpc: TradeRpc,
  account: Address,
): Promise<ChainAccount | null> {
  const { value } = await rpc
    .getAccountInfo(account, { encoding: 'base64', commitment: 'confirmed' })
    .send(rpcTimeout())
  if (!value) return null
  return {
    owner: value.owner,
    lamports: value.lamports,
    data: Uint8Array.from(getBase64Encoder().encode(value.data[0])),
  }
}

// SPL token account layout: mint (32), owner (32), amount (u64 LE) at 64.
const AMOUNT_OFFSET = 64

/** The balance of an SPL token account; a missing account holds nothing. */
export function tokenBalance(account: ChainAccount | null) {
  if (!account) return 0n
  if (
    account.owner !== TOKEN_PROGRAM ||
    account.data.length < AMOUNT_OFFSET + 8
  )
    return 0n
  return getU64Decoder().decode(account.data, AMOUNT_OFFSET)
}

/**
 * The wallet's cross-margin position in one market, in tokens (negative for
 * a short), read from the chain: what an order actually filled is the
 * difference before and after it.
 */
export async function positionSize(
  rpc: TradeRpc,
  wallet: Address,
  position: PositionRef,
) {
  const trader = await fetchAccount(rpc, await traderAccountAddress(wallet))
  const lots = trader ? positionLots(trader.data, position.assetId) : 0n
  return fromLots(lots.toString(), position.baseLotsDecimals)
}
