import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots } from '../../units'
import { checkCancel, checkPhoenixBundle } from '../checks'
import { MAX_CANCEL_IDS, cancelInstruction, sweepInstructions } from '../rise'
import { ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import {
  MarketSymbol,
  Subaccount,
  marketConfig,
  ordersAccount,
  perpTrade,
  requireActivated,
} from './shared'

export const cancelOrders = defineTradeTool({
  name: 'phoenix_cancel_orders',
  title: 'Cancel Phoenix orders',
  description: [
    'Prepares a cancel of resting orders in one Phoenix perps market, in the wallet’s cross-margin account or an isolated subaccount.',
    'Give orderIds (from phoenix_get_account) to cancel those orders, or omit them to cancel every resting order the account has in the market.',
    'When a cancel empties an isolated subaccount, its collateral returns to the cross-margin account in the same transaction.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      subaccount: Subaccount.optional().describe(
        'Subaccount holding the orders, from phoenix_get_account: 0 is cross margin, the others isolated. Needed only when more than one holds orders in the market',
      ),
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
    const [market, keys] = await Promise.all([
      marketConfig(context, input.symbol),
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated(context, wallet),
    ])
    const account = await ordersAccount(
      context,
      wallet,
      market.symbol,
      input.subaccount,
    )
    const { subaccount, orders: open } = account
    const isolated = subaccount > 0

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

    const instruction = await cancelInstruction(
      wallet,
      keys,
      market,
      targets,
      subaccount,
    )
    checkCancel(instruction, targets)
    const sweeps =
      isolated && account.emptiedBy(chosen)
        ? await sweepInstructions(wallet, keys, subaccount)
        : []
    if (sweeps.length > 0)
      await checkPhoenixBundle(sweeps, { wallet, keys, market, subaccount })

    const describe = (order: (typeof open)[number]) =>
      `${order.side} ${fromLots(order.sizeRemainingLots, market.baseLotsDecimals)} at $${order.priceUsd}`
    return {
      kind: 'instructions',
      wallet,
      instructions: [instruction, ...sweeps],
      summary: wanted
        ? `Cancel ${chosen.length} resting ${market.symbol} order${chosen.length === 1 ? '' : 's'}${isolated ? ` in isolated subaccount ${subaccount}` : ''}`
        : `Cancel all ${open.length} resting ${market.symbol} order${open.length === 1 ? '' : 's'} in ${isolated ? `isolated subaccount ${subaccount}` : 'the cross-margin account'}`,
      details: {
        ...(isolated ? { subaccount: String(subaccount) } : {}),
        ...Object.fromEntries(
          chosen.map((order) => [
            `order ${order.orderSequenceNumber}`,
            describe(order),
          ]),
        ),
      },
      trade: perpTrade('cancel', {
        symbol: market.symbol,
        cancelled: chosen.length,
        ...(isolated ? { marginMode: 'isolated' as const, subaccount } : {}),
      }),
      warnings: [
        ...(wanted
          ? []
          : [
              'This cancels every resting order the account has in this market when it lands, including any placed after this was prepared.',
            ]),
        ...(sweeps.length > 0
          ? [
              'This empties the isolated subaccount, so its collateral returns to your cross-margin account in the same transaction. If the subaccount is no longer empty when this lands, the collateral stays there.',
            ]
          : []),
      ],
    }
  },
})
