import {
  PhoenixAccount,
  PhoenixCandles,
  PhoenixFills,
} from '@lanatools/contracts'
import type { PhoenixCandleInterval } from '@lanatools/contracts'
import { authorized } from './mcp-clients'
import type { GetAccessToken } from './mcp-clients'

/** Reads for the Phoenix account page; Phoenix is mainnet only. */
export type PhoenixReader = {
  /** The signed-in user, or null on the public page. */
  viewer: string | null
  account: (wallet: string) => Promise<PhoenixAccount>
  candles: (
    symbol: string,
    interval: PhoenixCandleInterval,
  ) => Promise<PhoenixCandles>
  fills: (wallet: string, cursor: string | undefined) => Promise<PhoenixFills>
}

function phoenixReader(
  viewer: string | null,
  base: string,
  headers: () => Promise<HeadersInit>,
): PhoenixReader {
  async function read(path: string) {
    const response = await fetch(`${base}${path}`, {
      headers: await headers(),
    })
    if (!response.ok) throw new Error('Phoenix could not be read right now.')
    const body: unknown = await response.json()
    return body
  }
  return {
    viewer,
    account: async (wallet) =>
      PhoenixAccount.assert(
        await read(`/account/${encodeURIComponent(wallet)}`),
      ),
    candles: async (symbol, interval) =>
      PhoenixCandles.assert(
        await read(
          `/candles/${encodeURIComponent(symbol)}?interval=${interval}`,
        ),
      ),
    fills: async (wallet, cursor) => {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      return PhoenixFills.assert(
        await read(`/fills/${encodeURIComponent(wallet)}${query}`),
      )
    },
  }
}

export const signedInPhoenixReader = (
  userId: string,
  getAccessToken: GetAccessToken,
) => phoenixReader(userId, '/api/phoenix', () => authorized(getAccessToken))

export const publicPhoenixReader = phoenixReader(
  null,
  '/api/public/phoenix',
  async () => ({}),
)
