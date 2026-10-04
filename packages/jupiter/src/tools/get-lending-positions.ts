import type { z } from 'zod'
import type { LendingPositionsInput } from '../inputs'
import { isRecord } from '../client'
import type { ReadContext } from '../client'
import type { LendingPositionsData } from '../types'

export async function getLendingPositions(
  context: ReadContext,
  input: z.output<typeof LendingPositionsInput>,
): Promise<LendingPositionsData> {
  if (input.view === 'earn_earnings') {
    const value = await context.get('/lend/v1/earn/earnings', {
      user: input.wallet,
      positions: input.positionAddresses.join(','),
    })
    return {
      view: input.view,
      wallet: input.wallet,
      earnings: context.records(isRecord(value) ? [value] : value),
    }
  }
  if (input.view === 'borrow_positions')
    return {
      view: input.view,
      market: input.market,
      positions: context.records(
        await context.get('/lend/v1/borrow/positions', {
          users: input.wallets.join(','),
          market: input.market,
        }),
      ),
    }
  return {
    view: input.view,
    positions: context.records(
      await context.get('/lend/v1/earn/positions', {
        users: input.wallets.join(','),
      }),
    ),
  }
}
