import type { ConditionalTrigger, PositionTriggers, Trigger } from './schemas'
import { ticksToPrice } from './trade/price'
import type { MarketUnits } from './trade/price'
import { fromLots } from './units'

/**
 * A position's take profit and stop loss triggers, in USD and tokens. Legacy
 * triggers come from Phoenix's old stop-loss API and carry no size.
 */
export function takeProfitAndStopLoss(
  position: PositionTriggers,
  market: MarketUnits,
) {
  const legacy = (triggerId: string, trigger: Trigger, status: string) => ({
    triggerId,
    triggerPrice: ticksToPrice(BigInt(trigger.triggerPriceTicks), market),
    worstPrice: ticksToPrice(BigInt(trigger.executionPriceTicks), market),
    orderKind: trigger.kind,
    size: null as string | null,
    percent: null as number | null,
    status,
    legacy: true,
  })
  const conditional = (
    triggerId: string,
    trigger: ConditionalTrigger,
    status: string,
  ) => ({
    ...legacy(triggerId, trigger, status),
    size: trigger.usePercent
      ? null
      : fromLots(trigger.maxSizeLots, market.baseLotsDecimals),
    percent: trigger.usePercent ? trigger.percent : null,
    legacy: false,
  })
  return {
    takeProfit: [
      ...position.conditionalTakeProfitTriggers.map((row) =>
        conditional(row.conditionalTakeProfitId, row.trigger, row.status),
      ),
      ...position.takeProfitTriggers.map((row) =>
        legacy(row.takeProfitId, row.trigger, row.status),
      ),
    ],
    stopLoss: [
      ...position.conditionalStopLossTriggers.map((row) =>
        conditional(row.conditionalStopLossId, row.trigger, row.status),
      ),
      ...position.stopLossTriggers.map((row) =>
        legacy(row.stopLossId, row.trigger, row.status),
      ),
    ],
  }
}
