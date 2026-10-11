import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
} from 'lightweight-charts'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import type { PhoenixCandles } from '@lanatools/contracts'
import { formatPrice } from '#/lib/trades'

type Candle = PhoenixCandles['candles'][number]

/** A horizontal level on the chart: entry, liquidation or a resting order. */
export type ChartLine = {
  price: number
  title: string
  tone: 'entry' | 'liquidation' | 'order'
}

/** Decimals the market quotes in: the most any recent candle carries, cents at least. */
function decimalsFor(candles: Candle[]) {
  const places = candles
    .slice(-50)
    .flatMap((candle) => [candle.open, candle.high, candle.low, candle.close])
    .map(
      (value) =>
        (String(Number(value.toPrecision(12))).split('.')[1] ?? '').length,
    )
  return Math.max(2, ...places)
}

/** Colour tokens from the dashboard theme the chart sits in. */
function palette(element: HTMLElement) {
  const css = getComputedStyle(element)
  const token = (name: string) => css.getPropertyValue(name).trim()
  return {
    panel: token('--d-panel'),
    text: token('--d-text'),
    muted: token('--d-text-3'),
    line: token('--d-line'),
    accent: token('--d-accent'),
    up: token('--d-live'),
    down: token('--d-bad'),
    entry: token('--d-text-2'),
  }
}

/** The theme on the nearest dashboard frame, kept current. */
function useFrameTheme(element: HTMLElement | null) {
  const [theme, setTheme] = useState<string | null>(null)
  useEffect(() => {
    const frame = element?.closest('.dash')
    if (!frame) return
    const read = () => setTheme(frame.getAttribute('data-theme'))
    read()
    const observer = new MutationObserver(read)
    observer.observe(frame, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [element])
  return theme
}

const localTime = (time: Time, options: Intl.DateTimeFormatOptions) =>
  typeof time === 'number'
    ? new Date(time * 1000).toLocaleString('en-US', options)
    : String(time)

/**
 * A market's candles with the position's levels drawn across them. Drag to
 * pan, scroll or pinch to zoom, drag an axis to scale it. TradingView's
 * attribution logo stays on, as Lightweight Charts' licence asks.
 *
 * The chart is built once per market, interval and theme. Refreshed candles
 * and levels update it in place, so a refresh never moves the user's view;
 * only Reset view or a new market does.
 */
export function PerpChart({
  market,
  candles,
  lines,
  fitLiquidation,
  resetKey,
}: {
  /** Identifies what is charted, e.g. "SOL 1d"; a new one starts fresh. */
  market: string
  candles: Candle[]
  lines: ChartLine[]
  /**
   * Widen the fitted price range to reach every level. Off, the price axis
   * fits the candles, as trading screens do, and a level shows when in view.
   */
  fitLiquidation: boolean
  /** Changing it returns the chart to its opening view. */
  resetKey: number
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const theme = useFrameTheme(host)
  const [hovered, setHovered] = useState<Candle | null>(null)
  const chart = useRef<IChartApi | null>(null)
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const drawn = useRef<IPriceLine[]>([])
  /** Prices the fitted range must reach; read by the series' autoscale. */
  const reach = useRef<number[]>([])
  const decimals = decimalsFor(candles)
  // Levels arrive as a new array on every render; redraw only on change.
  const linesKey = JSON.stringify(lines)
  const latestLines = useRef(lines)
  latestLines.current = lines

  // Build the chart for this market and theme.
  useEffect(() => {
    if (!host) return
    const colors = palette(host)
    const api = createChart(host, {
      autoSize: true,
      layout: {
        background: { color: colors.panel },
        textColor: colors.muted,
        fontFamily: "'Paper Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: colors.line, style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: colors.line,
        scaleMargins: { top: 0.12, bottom: 0.1 },
      },
      timeScale: {
        borderColor: colors.line,
        rightOffset: 4,
        // Intraday candles need times on the axis, not only dates.
        timeVisible: true,
        secondsVisible: false,
        // Local time, as the rest of the dashboard.
        tickMarkFormatter: (time: Time, type: TickMarkType) =>
          localTime(
            time,
            type >= TickMarkType.Time
              ? { hour: 'numeric', minute: '2-digit' }
              : { month: 'short', day: 'numeric' },
          ),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: colors.muted, labelBackgroundColor: colors.text },
        horzLine: { color: colors.muted, labelBackgroundColor: colors.text },
      },
      localization: {
        timeFormatter: (time: Time) =>
          localTime(time, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }),
      },
    })
    const candlesticks = api.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineColor: colors.accent,
      autoscaleInfoProvider: (
        original: () => {
          priceRange: { minValue: number; maxValue: number } | null
        } | null,
      ) => {
        const fitted = original()
        if (!fitted?.priceRange || reach.current.length === 0) return fitted
        return {
          ...fitted,
          priceRange: {
            minValue: Math.min(fitted.priceRange.minValue, ...reach.current),
            maxValue: Math.max(fitted.priceRange.maxValue, ...reach.current),
          },
        }
      },
    })
    api.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(candlesticks)
      setHovered(
        data && 'open' in data
          ? {
              time: Number(param.time),
              open: data.open,
              high: data.high,
              low: data.low,
              close: data.close,
            }
          : null,
      )
    })
    chart.current = api
    series.current = candlesticks
    drawn.current = []
    return () => {
      api.remove()
      chart.current = null
      series.current = null
      drawn.current = []
    }
  }, [host, theme, market])

  // Candles: replaced in place on every refresh. The first set for a
  // market opens on the latest candles at the library's default width.
  const opened = useRef<string | null>(null)
  useEffect(() => {
    const api = chart.current
    const candlesticks = series.current
    if (!api || !candlesticks) return
    candlesticks.applyOptions({
      priceFormat: {
        type: 'price',
        precision: decimals,
        minMove: 10 ** -decimals,
      },
    })
    api.applyOptions({
      localization: {
        priceFormatter: (price: number) =>
          formatPrice(Number(price.toFixed(decimals))),
      },
    })
    candlesticks.setData(
      candles.map(({ time, ...ohlc }) => ({
        time: time as UTCTimestamp,
        ...ohlc,
      })),
    )
    const key = `${market}:${theme ?? ''}`
    if (opened.current !== key && candles.length > 0) {
      opened.current = key
      api.timeScale().scrollToRealTime()
    }
  }, [candles, decimals, market, theme])

  // Levels: redrawn only when they change.
  useEffect(() => {
    const candlesticks = series.current
    const api = chart.current
    if (!candlesticks || !api) return
    const colors = palette(api.chartElement())
    for (const line of drawn.current) candlesticks.removePriceLine(line)
    const levels = latestLines.current
    drawn.current = levels.map((line) =>
      candlesticks.createPriceLine({
        price: line.price,
        title: line.title,
        axisLabelVisible: true,
        color:
          line.tone === 'liquidation'
            ? colors.down
            : line.tone === 'entry'
              ? colors.entry
              : colors.muted,
        lineWidth: line.tone === 'liquidation' ? 2 : 1,
        lineStyle:
          line.tone === 'entry'
            ? LineStyle.Dashed
            : line.tone === 'order'
              ? LineStyle.SparseDotted
              : LineStyle.Solid,
      }),
    )
    reach.current = fitLiquidation ? levels.map((line) => line.price) : []
    api.priceScale('right').applyOptions({ autoScale: true })
  }, [linesKey, fitLiquidation, market, theme])

  // Reset view: latest candles, price axis fitted again.
  const resets = useRef(resetKey)
  useEffect(() => {
    const api = chart.current
    if (!api || resets.current === resetKey) return
    resets.current = resetKey
    api.timeScale().resetTimeScale()
    api.timeScale().scrollToRealTime()
    api.priceScale('right').applyOptions({ autoScale: true })
  }, [resetKey])

  const shown = hovered ?? candles.at(-1)
  const up = shown ? shown.close >= shown.open : true
  return (
    <div className="flex min-w-0 flex-col">
      <p className="flex min-h-7 flex-wrap gap-x-3.5 px-4 pt-2.5 font-mono text-[11.5px] text-fg-3">
        {shown &&
          (['open', 'high', 'low', 'close'] as const).map((key) => (
            <span key={key}>
              {key[0]?.toUpperCase()}{' '}
              <b className={`font-semibold ${up ? 'text-live' : 'text-bad'}`}>
                {formatPrice(Number(shown[key].toFixed(decimals)))}
              </b>
            </span>
          ))}
      </p>
      <div
        ref={setHost}
        className="h-[360px] w-full"
        role="img"
        aria-label="Price chart with entry, liquidation and order levels"
      />
    </div>
  )
}
