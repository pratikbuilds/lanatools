import {
  PhoenixAccount,
  PhoenixCandles,
  PhoenixFills,
} from '@lanatools/contracts'
import type { PhoenixCandleRange } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

/** Reads for the Phoenix account page; Phoenix is mainnet only. */

async function read(getAccessToken: GetAccessToken, path: string) {
  const response = await fetch(path, {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Phoenix could not be read right now.')
  const body: unknown = await response.json()
  return body
}

export async function getPhoenixAccount(
  getAccessToken: GetAccessToken,
  wallet: string,
) {
  return PhoenixAccount.assert(
    await read(
      getAccessToken,
      `/api/phoenix/account/${encodeURIComponent(wallet)}`,
    ),
  )
}

export async function getPhoenixCandles(
  getAccessToken: GetAccessToken,
  symbol: string,
  range: PhoenixCandleRange,
) {
  return PhoenixCandles.assert(
    await read(
      getAccessToken,
      `/api/phoenix/candles/${encodeURIComponent(symbol)}?range=${range}`,
    ),
  )
}

export async function getPhoenixFills(
  getAccessToken: GetAccessToken,
  wallet: string,
  cursor: string | undefined,
) {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return PhoenixFills.assert(
    await read(
      getAccessToken,
      `/api/phoenix/fills/${encodeURIComponent(wallet)}${query}`,
    ),
  )
}
