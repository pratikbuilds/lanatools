import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  CrosshairMode,
  LineStyle,
  TickMarkType,
  createChart,
} from 'lightweight-charts'
import type { IChartApi, Time, UTCTimestamp } from 'lightweight-charts'
import type { PhoenixCandles } from '@lanatools/contracts'
import { formatUSD } from '#/lib/trades'

type Candle = PhoenixCandles['candles'][number]

/** A horizontal level on the chart: entry, liquidation or a resting order. */
export type ChartLine = {
  price: number
  title: string
  tone: 'entry' | 'liquidation' | 'order'
}

/** Decimals a price is shown with: cents, or more for sub-dollar markets. */
const decimalsFor = (price: number) => (price >= 1 ? 2 : 6)

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
 */
export function PerpChart({
  candles,
  lines,
  fitLiquidation,
  resetKey,
}: {
  candles: Candle[]
  lines: ChartLine[]
  /** Widen the fitted price range to reach the liquidation line. */
  fitLiquidation: boolean
  /** Changing it redraws the chart at its fitted view. */
  resetKey: number
}) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const theme = useFrameTheme(host)
  const [hovered, setHovered] = useState<Candle | null>(null)
  const chart = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!host || candles.length === 0) return
    const colors = palette(host)
    const last = candles.at(-1)?.close ?? 0
    const decimals = decimalsFor(last)
    const money = (price: number) => formatUSD(Number(price.toFixed(decimals)))
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
        priceFormatter: money,
        timeFormatter: (time: Time) =>
          localTime(time, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          }),
      },
    })
    const liquidation = lines.find((line) => line.tone === 'liquidation')
    const reach = lines
      .filter((line) => line.tone !== 'liquidation' || fitLiquidation)
      .map((line) => line.price)
    const series = api.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      borderVisible: false,
      priceLineColor: colors.accent,
      priceFormat: {
        type: 'price',
        precision: decimals,
        minMove: 10 ** -decimals,
      },
      autoscaleInfoProvider: (
        original: () => {
          priceRange: { minValue: number; maxValue: number } | null
        } | null,
      ) => {
        const fitted = original()
        if (!fitted?.priceRange || reach.length === 0) return fitted
        return {
          ...fitted,
          priceRange: {
            minValue: Math.min(fitted.priceRange.minValue, ...reach),
            maxValue: Math.max(fitted.priceRange.maxValue, ...reach),
          },
        }
      },
    })
    series.setData(
      candles.map(({ time, ...ohlc }) => ({
        time: time as UTCTimestamp,
        ...ohlc,
      })),
    )
    for (const line of lines)
      series.createPriceLine({
        price: line.price,
        title: line.title,
        axisLabelVisible: true,
        color:
          line.tone === 'liquidation'
            ? colors.down
            : line.tone === 'entry'
              ? colors.entry
              : colors.muted,
        lineWidth: line === liquidation ? 2 : 1,
        lineStyle:
          line.tone === 'entry'
            ? LineStyle.Dashed
            : line.tone === 'order'
              ? LineStyle.SparseDotted
              : LineStyle.Solid,
      })
    api.timeScale().fitContent()
    api.subscribeCrosshairMove((param) => {
      const data = param.seriesData.get(series)
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
    return () => {
      api.remove()
      chart.current = null
    }
  }, [host, candles, lines, fitLiquidation, resetKey, theme])

  const shown = hovered ?? candles.at(-1)
  const decimals = decimalsFor(shown?.close ?? 0)
  const up = shown ? shown.close >= shown.open : true
  return (
    <div className="flex min-w-0 flex-col">
      <p className="flex min-h-7 flex-wrap gap-x-3.5 px-4 pt-2.5 font-mono text-[11.5px] text-fg-3">
        {shown &&
          (['open', 'high', 'low', 'close'] as const).map((key) => (
            <span key={key}>
              {key[0]?.toUpperCase()}{' '}
              <b className={`font-semibold ${up ? 'text-live' : 'text-bad'}`}>
                {formatUSD(Number(shown[key].toFixed(decimals)))}
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
