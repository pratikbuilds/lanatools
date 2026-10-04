import type { z } from 'zod'
import type { TriggerOrdersInput } from '../inputs'
import { isRecord, unavailable } from '../client'
import type { ReadContext } from '../client'
import type { TriggerOrdersData } from '../types'

export async function getTriggerOrders(
  context: ReadContext,
  input: z.output<typeof TriggerOrdersInput>,
): Promise<TriggerOrdersData> {
  const parameters: Record<string, string> = {
    user: input.wallet,
    orderStatus: input.orderStatus,
    page: String(input.page),
  }
  if (input.inputMint) parameters.inputMint = input.inputMint
  if (input.outputMint) parameters.outputMint = input.outputMint
  if (input.view === 'legacy_dca_orders') {
    parameters.recurringType = 'time'
    // Required by the live legacy API despite omission in guide examples.
    parameters.includeFailedTx = String(input.includeFailedTx)
  }
  const value = await context.get(
    input.view === 'legacy_price_orders'
      ? '/trigger/v1/getTriggerOrders'
      : '/recurring/v1/getRecurringOrders',
    parameters,
  )
  if (!isRecord(value)) throw unavailable()
  const totalPages =
    typeof value.totalPages === 'number' &&
    Number.isSafeInteger(value.totalPages) &&
    value.totalPages >= 0
      ? value.totalPages
      : null
  const totalItems =
    typeof value.totalItems === 'number' &&
    Number.isSafeInteger(value.totalItems) &&
    value.totalItems >= 0
      ? value.totalItems
      : null
  const page =
    typeof value.page === 'number' &&
    Number.isSafeInteger(value.page) &&
    value.page >= 1
      ? value.page
      : input.page
  const hasMoreData =
    typeof value.hasMoreData === 'boolean'
      ? value.hasMoreData
      : totalPages !== null
        ? page < totalPages
        : null
  context.warnings.push(
    'These unmaintained v1 reads cover legacy orders only; newer product orders are not included.',
  )
  return {
    view: input.view,
    apiVersion: 'v1',
    maintenance: 'legacy',
    wallet: input.wallet,
    orders: context.records(
      input.view === 'legacy_dca_orders'
        ? (value.time ?? value.orders)
        : value.orders,
    ),
    pagination: { page, hasMoreData, totalPages, totalItems },
  }
}
