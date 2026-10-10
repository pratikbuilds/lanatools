import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots } from '../../units'
import { checkCancel } from '../checks'
import { MAX_CANCEL_IDS, cancelInstruction } from '../rise'
import { ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import {
  MarketSymbol,
  crossAccount,
  marketConfig,
  requireActivated,
} from './shared'

export const cancelOrders = defineTradeTool({
  name: 'phoenix_cancel_orders',
  title: 'Cancel Phoenix orders',
  description: [
    'Prepares a cancel of resting orders in one Phoenix perps market, in the wallet’s cross-margin account.',
    'Give orderIds (from phoenix_get_account) to cancel those orders, or omit them to cancel every resting order the account has in the market.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      orderIds: z
        .array(z.string().trim().regex(/^\d+$/, 'Expected an order ID'))
        .min(1)
        .max(MAX_CANCEL_IDS)
        .optional()
        .describe(
          'Order IDs from phoenix_get_account; omit to cancel all orders in the market',
        ),
    })
    .strict(),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const [market, account, keys] = await Promise.all([
      marketConfig(context, input.symbol),
      crossAccount(context, wallet),
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated(context, wallet),
    ])
    const open = account.ordersIn(market.symbol)
    if (open.length === 0)
      throw new PhoenixError(
        'not_found',
        `This account has no resting ${market.symbol} orders`,
      )

    const wanted = input.orderIds ? [...new Set(input.orderIds)] : null
    const missing = (wanted ?? []).filter(
      (id) => !open.some((order) => order.orderSequenceNumber === id),
    )
    if (missing.length > 0)
      throw new PhoenixError(
        'not_found',
        `No resting ${market.symbol} order ${missing.join(', ')}; open order IDs: ${open.map((order) => order.orderSequenceNumber).join(', ')}`,
      )
    const chosen = wanted
      ? open.filter((order) => wanted.includes(order.orderSequenceNumber))
      : open
    const targets = wanted
      ? chosen.map((order) => ({
          priceInTicks: BigInt(order.priceTicks),
          orderSequenceNumber: BigInt(order.orderSequenceNumber),
        }))
      : null

    const instruction = await cancelInstruction(wallet, keys, market, targets)
    checkCancel(instruction, targets)

    const describe = (order: (typeof open)[number]) =>
      `${order.side} ${fromLots(order.sizeRemainingLots, market.baseLotsDecimals)} at $${order.priceUsd}`
    return {
      kind: 'instructions',
      wallet,
      instructions: [instruction],
      summary: wanted
        ? `Cancel ${chosen.length} resting ${market.symbol} order${chosen.length === 1 ? '' : 's'}`
        : `Cancel all ${open.length} resting ${market.symbol} order${open.length === 1 ? '' : 's'} in the cross-margin account`,
      details: Object.fromEntries(
        chosen.map((order) => [
          `order ${order.orderSequenceNumber}`,
          describe(order),
        ]),
      ),
      warnings: wanted
        ? []
        : [
            'This cancels every resting order the account has in this market when it lands, including any placed after this was prepared.',
          ],
    }
  },
})
