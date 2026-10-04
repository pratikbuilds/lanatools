import { z } from 'zod'

// Only the fields the tools read. Phoenix adds fields often (Rise ships
// several releases a day), so unknown fields are dropped, not rejected.

const Lots = z.union([z.string().regex(/^-?\d+$/), z.number().int()])
const Decimal = z.union([z.string(), z.number()]).transform(Number)
const Timestamp = z.union([z.string(), z.number()])
const Cursor = z.string().nullish()

export const MarketConfig = z.object({
  symbol: z.string(),
  marketStatus: z.string(),
  metadata: z.object({ name: z.string().nullish() }).nullish(),
  baseLotsDecimals: z.number().int(),
  takerFee: z.number(),
  makerFee: z.number(),
  leverageTiers: z.array(
    z.object({ maxLeverage: z.number(), maxSizeBaseLots: Lots }),
  ),
  fundingIntervalSeconds: z.number(),
  maxFundingRatePerIntervalPercentage: z.number(),
  openInterestCapBaseLots: Lots,
  isolatedOnly: z.boolean(),
})
export type MarketConfig = z.infer<typeof MarketConfig>
export const MarketConfigs = z.array(MarketConfig)

export const MarketStats = z.object({
  symbol: z.string(),
  timestamp_ms: Timestamp,
  mark_price: z.number(),
  oracle_price: z.number(),
  prev_day_mark_price: z.number(),
  open_interest: z.number(),
  day_volume_usd: z.number(),
  current_funding_rate: z.number(),
  eight_hour_funding_rate: z.number(),
  annualized_funding_rate: z.number(),
})
export type MarketStats = z.infer<typeof MarketStats>
export const AllMarketStats = z.object({ markets: z.array(MarketStats) })

const Level = z.tuple([z.number(), z.number()])
export const Orderbook = z.object({
  symbol: z.string(),
  mid: z.number().nullish(),
  bids: z.array(Level),
  asks: z.array(Level),
})

export const Candles = z.array(
  z.object({
    time: z.number(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
    volumeQuote: z.number(),
    tradeCount: z.number(),
  }),
)

export const TraderState = z.object({
  authority: z.string(),
  snapshot: z.object({
    subaccounts: z.array(
      z.object({
        subaccountIndex: z.number().int(),
        collateral: Lots,
        spotCollaterals: z
          .array(
            z.object({
              symbol: z.string(),
              balance: Lots,
              decimals: z.number().int().nonnegative(),
            }),
          )
          .default([]),
        positions: z
          .array(
            z.object({
              symbol: z.string(),
              basePositionLots: Lots,
              entryPriceUsd: z.string().nullish(),
              virtualQuotePositionLots: Lots,
              accumulatedFundingQuoteLots: Lots,
            }),
          )
          .default([]),
        orders: z
          .array(
            z.object({
              symbol: z.string(),
              orders: z.array(
                z.object({
                  orderSequenceNumber: z.string(),
                  side: z.string(),
                  orderType: z.string(),
                  priceUsd: z.string(),
                  sizeRemainingLots: Lots,
                  reduceOnly: z.boolean(),
                  status: z.string(),
                }),
              ),
            }),
          )
          .default([]),
      }),
    ),
  }),
})

// Trade-history sizes are already in tokens despite the `Lots` names:
// a 2044-lot SOL position shows as baseLotsAfter "20.44".
export const TradeHistory = z.object({
  data: z.array(
    z.object({
      marketSymbol: z.string(),
      subaccountIndex: z.number().int(),
      timestamp: Timestamp,
      baseLotsDelta: Decimal,
      price: Decimal,
      realizedPnl: Decimal,
      fees: Decimal,
      liquidity: z.string(),
      tradeType: z.string(),
      signature: z.string().nullish(),
    }),
  ),
  nextCursor: Cursor,
  hasMore: z.boolean(),
})

export const OrderHistory = z.object({
  data: z.array(
    z.object({
      orderSequenceNumber: z.string(),
      marketSymbol: z.string(),
      status: z.string(),
      side: z.union([z.string(), z.number()]),
      price: z.string(),
      baseQty: z.string(),
      remainingBaseQty: z.string(),
      filledBaseQty: z.string(),
      isReduceOnly: z.boolean().nullish(),
      placedAt: Timestamp.nullish(),
      completedAt: Timestamp.nullish(),
    }),
  ),
  nextCursor: Cursor,
  hasMore: z.boolean(),
})

export const FundingHistory = z.object({
  events: z.array(
    z.object({
      timestamp: Timestamp,
      symbol: z.string(),
      fundingPayment: Decimal,
      fundingRatePercentage: Decimal,
      positionSize: Decimal,
      positionSide: z.string(),
    }),
  ),
  nextCursor: Cursor,
  hasMore: z.boolean(),
})

// Amounts are quote lots (USDC, 6 decimals): `collateralAfter` matches the
// subaccount's `collateral` in the trader state.
export const CollateralHistory = z.object({
  data: z.array(
    z.object({
      timestamp: Timestamp,
      traderSubaccountIndex: z.union([z.number(), z.string()]),
      eventType: z.string(),
      amount: Lots,
      collateralAfter: Lots,
    }),
  ),
  nextCursor: Cursor,
  hasMore: z.boolean(),
})

export const PnlHistory = z.array(
  z.object({
    startTime: z.number(),
    endTime: z.number(),
    cumulativePnl: z.number(),
    unrealizedPnl: z.number(),
    cumulativeFundingPayment: z.number(),
    cumulativeTakerFee: z.number(),
    cumulativeMakerFee: z.number(),
  }),
)
