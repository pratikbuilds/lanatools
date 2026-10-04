import { z } from 'zod'
import {
  AllMarketStats,
  Candles,
  MarketConfig,
  MarketConfigs,
  MarketStats,
  Orderbook,
} from '../schemas'
import { MarketSymbol, UNTRUSTED, defineTool, forMarket } from '../tool'
import { fromLots, isoTime, tidy } from '../units'

const pct = (fraction: number) => tidy(fraction * 100)

// Phoenix reports funding rates already in percent, per funding interval
// (one hour on every market today): annualized = current × 8760.
function marketStats(stats: MarketStats) {
  const prev = stats.prev_day_mark_price
  return {
    markPrice: tidy(stats.mark_price),
    oraclePrice: tidy(stats.oracle_price),
    change24hPct: prev
      ? Number((((stats.mark_price - prev) / prev) * 100).toFixed(4))
      : null,
    volume24hUsd: tidy(stats.day_volume_usd),
    openInterest: tidy(stats.open_interest),
    openInterestUsd: tidy(stats.open_interest * stats.mark_price),
    fundingRatePct: {
      current: tidy(stats.current_funding_rate),
      eightHour: tidy(stats.eight_hour_funding_rate),
      annualized: tidy(stats.annualized_funding_rate),
    },
    updatedAt: isoTime(stats.timestamp_ms),
  }
}

const maxLeverage = (config: MarketConfig) =>
  Math.max(0, ...config.leverageTiers.map((tier) => tier.maxLeverage))

export const listMarkets = defineTool({
  name: 'phoenix_list_markets',
  title: 'List Phoenix perp markets',
  description: [
    'Lists every perpetual futures market on Phoenix (Solana mainnet), busiest first: mark price, 24h change and volume, open interest, funding rate and max leverage.',
    'Use phoenix_get_market for one market in detail. Funding rates are percent per funding interval (one hour).',
    UNTRUSTED,
  ].join(' '),
  input: z.object({}).strict(),
  async run(client) {
    const [configs, stats] = await Promise.all([
      client.get('/v1/view/exchange/markets', MarketConfigs),
      client.get('/v1/markets/stats/latest', AllMarketStats),
    ])
    const bySymbol = new Map(stats.markets.map((item) => [item.symbol, item]))
    const volume = (config: MarketConfig) =>
      bySymbol.get(config.symbol)?.day_volume_usd ?? -1
    const markets = [...configs]
      .sort((a, b) => volume(b) - volume(a))
      .map((config) => {
        const latest = bySymbol.get(config.symbol)
        return {
          symbol: config.symbol,
          name: config.metadata?.name ?? null,
          status: config.marketStatus,
          maxLeverage: maxLeverage(config),
          isolatedOnly: config.isolatedOnly,
          // A market listed without stats yet has no prices to report.
          ...(latest ? marketStats(latest) : { markPrice: null }),
        }
      })
    return { count: markets.length, markets }
  },
})

export const getMarket = defineTool({
  name: 'phoenix_get_market',
  title: 'Inspect a Phoenix market',
  description: [
    'Shows one Phoenix perp market: latest prices, 24h stats, funding, fees, leverage tiers with their max position size in tokens, and the open-interest cap.',
    UNTRUSTED,
  ].join(' '),
  input: z.object({ symbol: MarketSymbol }).strict(),
  async run(client, { symbol }) {
    const path = encodeURIComponent(symbol)
    const [config, stats] = await forMarket(symbol, () =>
      Promise.all([
        client.get(`/v1/view/exchange/market/${path}`, MarketConfig),
        client.get(`/v1/market/${path}/stats/latest`, MarketStats),
      ]),
    )
    const tokens = (lots: string | number) =>
      fromLots(lots, config.baseLotsDecimals)
    return {
      symbol: config.symbol,
      name: config.metadata?.name ?? null,
      status: config.marketStatus,
      isolatedOnly: config.isolatedOnly,
      ...marketStats(stats),
      takerFeePct: pct(config.takerFee),
      makerFeePct: pct(config.makerFee),
      maxLeverage: maxLeverage(config),
      leverageTiers: config.leverageTiers.map((tier) => ({
        maxLeverage: tier.maxLeverage,
        maxPositionSize: tokens(tier.maxSizeBaseLots),
      })),
      openInterestCap: tokens(config.openInterestCapBaseLots),
      fundingIntervalSeconds: config.fundingIntervalSeconds,
      maxFundingRatePctPerInterval: tidy(
        config.maxFundingRatePerIntervalPercentage,
      ),
      sizeDecimals: config.baseLotsDecimals,
    }
  },
})

export const getOrderbook = defineTool({
  name: 'phoenix_get_orderbook',
  title: 'Read a Phoenix order book',
  description: [
    'Reads the live order book of one Phoenix perp market: best bids and asks (price in USD, size in tokens), mid price and spread.',
    UNTRUSTED,
  ].join(' '),
  input: z
    .object({
      symbol: MarketSymbol,
      depth: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe('Price levels per side'),
    })
    .strict(),
  async run(client, { symbol, depth }) {
    const book = await forMarket(symbol, () =>
      client.get(`/v1/view/orderbook/${encodeURIComponent(symbol)}`, Orderbook),
    )
    const level = ([price, size]: [number, number]) => ({
      price: tidy(price),
      size: tidy(size),
    })
    const bestBid = book.bids[0]?.[0]
    const bestAsk = book.asks[0]?.[0]
    const mid = book.mid ?? null
    const spread =
      bestBid !== undefined && bestAsk !== undefined
        ? tidy(bestAsk - bestBid)
        : null
    return {
      symbol: book.symbol,
      mid: mid === null ? null : tidy(mid),
      spread,
      spreadBps:
        spread !== null && mid
          ? Number(((spread / mid) * 1e4).toFixed(2))
          : null,
      bids: book.bids.slice(0, depth).map(level),
      asks: book.asks.slice(0, depth).map(level),
    }
  },
})

export const getCandles = defineTool({
  name: 'phoenix_get_candles',
  title: 'Read Phoenix price candles',
  description: [
    'Reads recent OHLCV candles for one Phoenix perp market, oldest first. Volume is in tokens, volumeUsdc in USDC.',
    UNTRUSTED,
  ].join(' '),
  input: z
    .object({
      symbol: MarketSymbol,
      timeframe: z
        .enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
        .default('1h'),
      limit: z
        .number()
        .int()
        .min(1)
        .default(50)
        .describe('Number of most recent candles'),
    })
    .strict(),
  async run(client, { symbol, timeframe, limit }) {
    const candles = await forMarket(symbol, () =>
      client.get(`/v1/candles/${encodeURIComponent(symbol)}`, Candles, {
        timeframe,
        limit,
      }),
    )
    return {
      symbol,
      timeframe,
      candles: candles.map((candle) => ({
        time: isoTime(candle.time),
        open: tidy(candle.open),
        high: tidy(candle.high),
        low: tidy(candle.low),
        close: tidy(candle.close),
        volume: tidy(candle.volume),
        volumeUsdc: tidy(candle.volumeQuote),
        trades: candle.tradeCount,
      })),
    }
  },
})
