import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots } from '../../units'
import { conditionalOrders } from '../chain'
import { checkPhoenixBundle } from '../checks'
import type { ConditionalCancel } from '../checks'
import { traderAccountAddress } from '../rise'
import { ExchangeKeys } from '../schemas'
import type { OrderMarket } from '../schemas'
import { defineTradeTool } from '../tool'
import { fitsOneTransaction } from '../transaction'
import {
  MarketSymbol,
  PositionSubaccount,
  marginOf,
  marketConfig,
  openPosition,
  perpTrade,
  requireActivated,
  subaccountRequest,
  unitsOf,
} from './shared'
import { LEG_NAMES, describeLeg, legDirection, positionLegs } from './tpsl'
import type { TpslLeg } from './tpsl'

type Slot = ReturnType<typeof positionLegs>[number]

const LEGS = ['takeProfit', 'stopLoss'] as const

const legsOf = (slot: Slot) => LEGS.filter((leg) => slot[leg] !== null)

/** "1 (take profit, stop loss), 3 (stop loss)": what an agent can cancel. */
const listSlots = (slots: readonly Slot[]) =>
  slots
    .map(
      (slot) =>
        `${slot.slot} (${legsOf(slot)
          .map((leg) => LEG_NAMES[leg])
          .join(', ')})`,
    )
    .join(', ')

/** One review line: both legs of a slot share its size. */
function describeSlotLeg(slot: Slot, leg: TpslLeg, market: OrderMarket) {
  const trigger = slot[leg]
  if (!trigger) return ''
  const size =
    slot.sizePercent === null
      ? `${fromLots((slot.sizeBaseLots ?? 0n).toString(), market.baseLotsDecimals)} ${market.symbol}`
      : `${slot.sizePercent}% of the position`
  return `${describeLeg(trigger, unitsOf(market))}, size ${size}`
}

export const cancelTpsl = defineTradeTool({
  name: 'phoenix_cancel_tpsl',
  title: 'Cancel Phoenix TP/SL',
  description: [
    'Prepares a cancel of take profit, stop loss or both on an open Phoenix perps position, cross or isolated.',
    'Give slot to cancel one TP/SL; without it, every active TP/SL of that leg on the position is cancelled. Errors list the active slots.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      subaccount: PositionSubaccount,
      leg: z
        .enum(['takeProfit', 'stopLoss', 'both'])
        .describe('Which leg to cancel'),
      slot: z
        .number()
        .int()
        .min(1)
        .max(191)
        .optional()
        .describe(
          'The TP/SL slot in the account, 1 to 191; omit to cancel this leg on every active TP/SL of the position',
        ),
    })
    .strict(),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const [market, keys] = await Promise.all([
      marketConfig(context, input.symbol),
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated(context, wallet),
    ])
    const { subaccount, direction } = await openPosition(
      context,
      wallet,
      market.symbol,
      input.subaccount,
    )
    const active = positionLegs(
      (await conditionalOrders(
        context.rpc,
        await traderAccountAddress(wallet, subaccount),
      )) ?? [],
      market.assetId,
      direction,
    )
    if (active.length === 0)
      throw new PhoenixError(
        'not_found',
        `This ${market.symbol} position has no active TP/SL`,
      )

    const wantedLegs: readonly TpslLeg[] =
      input.leg === 'both' ? LEGS : [input.leg]
    const slots =
      input.slot === undefined
        ? active
        : active.filter((each) => each.slot === input.slot)
    const chosen = slots.flatMap((slot) =>
      wantedLegs
        .filter((leg) => slot[leg] !== null)
        .map((leg) => ({ slot, leg })),
    )
    if (chosen.length === 0)
      throw new PhoenixError(
        'not_found',
        `No active ${input.leg === 'both' ? 'TP/SL' : LEG_NAMES[input.leg]}${input.slot === undefined ? '' : ` in slot ${input.slot}`} on this ${market.symbol} position; active slots: ${listSlots(active)}`,
      )

    const cancels: ConditionalCancel[] = chosen.map(({ slot, leg }) => ({
      slot: slot.slot,
      leg: legDirection(leg, direction),
    }))
    const built = await Promise.all(
      cancels.map(({ slot, leg }) =>
        context.orders.cancelConditionalOrder({
          authority: wallet,
          traderPdaIndex: 0,
          ...subaccountRequest(subaccount),
          symbol: market.symbol,
          conditionalOrderIndex: slot,
          executionDirection: leg === 'greater' ? 'greater_than' : 'less_than',
        }),
      ),
    )
    const instructions = built.flat()
    await checkPhoenixBundle(instructions, {
      wallet,
      keys,
      market,
      subaccount,
      cancels,
    })
    if (!fitsOneTransaction(wallet, instructions))
      throw new PhoenixError(
        'invalid_input',
        `These cancels do not fit one transaction; give slot to cancel fewer. Active slots: ${listSlots(active)}`,
      )

    const left = active.reduce((sum, slot) => sum + legsOf(slot).length, 0)
    const remaining = left - chosen.length
    return {
      kind: 'instructions',
      wallet,
      instructions,
      summary: `Cancel ${chosen.length} TP/SL leg${chosen.length === 1 ? '' : 's'} on the ${market.symbol} ${direction}`,
      details: Object.fromEntries(
        chosen.map(({ slot, leg }) => [
          `slot ${slot.slot} ${LEG_NAMES[leg]}`,
          describeSlotLeg(slot, leg, market),
        ]),
      ),
      trade: perpTrade('cancel_tpsl', {
        symbol: market.symbol,
        closing: direction,
        ...marginOf(subaccount).terms,
        cancelled: chosen.length,
      }),
      warnings: [
        remaining === 0
          ? 'This position will have no TP/SL left.'
          : `This position keeps ${remaining} active TP/SL leg${remaining === 1 ? '' : 's'}.`,
      ],
    }
  },
})
