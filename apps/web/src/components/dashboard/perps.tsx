import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { isAddress } from '@solana/kit'
import { PHOENIX_CANDLE_INTERVALS } from '@lanatools/contracts'
import type {
  PhoenixAccount,
  PhoenixCandleInterval,
  PhoenixOrder,
  PhoenixPosition,
} from '@lanatools/contracts'
import { dayLabel, explorerURL, formatTime } from '#/lib/activity'
import type { PhoenixReader } from '#/lib/phoenix'
import { shortAddress } from '#/lib/transactions'
import { formatPrice, formatUSD, perpMarket } from '#/lib/trades'
import { PageHead, SectionHead } from './page-head'
import { PerpChart } from './perp-chart'
import type { ChartLine } from './perp-chart'
import { Skeleton } from './skeleton'

/**
 * One wallet's Phoenix account: the account's value, a candlestick chart
 * with the position's entry, liquidation and order levels, then positions,
 * resting orders and fills. Read-only; agents trade. Served both in the
 * dashboard and, with no login, as a public page; a failed refresh keeps the
 * last data on screen and the next one recovers.
 */
export function PerpsPage({
  address,
  reader,
  onAddress,
  own = false,
  back,
}: {
  address: string
  reader: PhoenixReader
  onAddress: (address: string) => void
  /** Whether this is the viewer's own LanaTools wallet. */
  own?: boolean
  /** A way back, shown above the title. */
  back?: ReactNode
}) {
  const account = useQuery({
    queryKey: ['phoenix-account', reader.viewer, address],
    queryFn: () => reader.account(address),
    // Marks move; pauses while the tab is hidden (spec D14).
    refetchInterval: 15_000,
  })

  return (
    <>
      {back}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHead title="Phoenix account">
          <span className="d-chip text-fg" title={address}>
            {own ? 'Your LanaTools wallet' : 'Wallet'} · {shortAddress(address)}
          </span>
        </PageHead>
        <AddressField onAddress={onAddress} />
      </div>
      {account.data?.exists ? (
        <Account account={account.data} reader={reader} />
      ) : account.isPending ? (
        <AccountSkeleton />
      ) : account.isError ? (
        <div className="d-empty mt-6">
          <p className="font-mono text-[13px]">
            Phoenix could not be read right now.
          </p>
          <button
            type="button"
            className="d-btn d-btn-sm mt-3"
            onClick={() => void account.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="d-empty mt-6">
          <h2 className="d-h2 text-fg">No Phoenix account for this address</h2>
          <p className="mx-auto mt-2 max-w-[34rem] text-[13px]">
            An agent opens one with{' '}
            <span className="font-mono">phoenix_activate_account</span>, then
            deposits USDC to trade. Positions, orders and fills show up here
            once it does.
          </p>
        </div>
      )}
    </>
  )
}

/** Any wallet's account can be viewed; Phoenix data is public. */
function AddressField({ onAddress }: { onAddress: (address: string) => void }) {
  const [text, setText] = useState('')
  const invalid = text.trim() !== '' && !isAddress(text.trim())
  return (
    <form
      className="w-full lg:w-[20rem]"
      onSubmit={(event) => {
        event.preventDefault()
        const next = text.trim()
        if (!isAddress(next)) return
        setText('')
        onAddress(next)
      }}
    >
      <input
        type="search"
        aria-label="View another address"
        aria-invalid={invalid}
        placeholder="View another address"
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="d-input w-full font-mono text-[12.5px]"
      />
    </form>
  )
}

function AccountSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="mt-6 h-[52px] w-full max-w-[34rem]" />
      <Skeleton className="d-card mt-5 h-[420px] w-full" />
    </div>
  )
}

const signed = (value: string | null) =>
  value === null ? '—' : formatUSD(value, { signed: true })
const tone = (value: string | null) =>
  value === null ? '' : Number(value) < 0 ? 'text-bad' : 'text-live'
/** Prices keep the precision Phoenix shows them with. */
const price = (value: string | null) =>
  value === null ? '—' : formatPrice(value)

/**
 * What the chart can show: each position, and each market where the account
 * only has resting orders. A market can hold a cross and an isolated
 * position at once, so a subaccount is part of what identifies one.
 */
type Charted = {
  key: string
  symbol: string
  subaccount: number
  position: PhoenixPosition | undefined
}

const chartKey = (subaccount: number, symbol: string) =>
  `${subaccount}:${symbol}`

function Account({
  account,
  reader,
}: {
  account: PhoenixAccount
  reader: PhoenixReader
}) {
  const charted = useMemo(() => {
    const items = new Map<string, Charted>()
    for (const position of account.positions)
      items.set(chartKey(position.subaccount, position.symbol), {
        key: chartKey(position.subaccount, position.symbol),
        symbol: position.symbol,
        subaccount: position.subaccount,
        position,
      })
    for (const order of account.orders) {
      const key = chartKey(order.subaccount, order.symbol)
      if (!items.has(key))
        items.set(key, {
          key,
          symbol: order.symbol,
          subaccount: order.subaccount,
          position: undefined,
        })
    }
    return [...items.values()]
  }, [account])
  const [picked, setPicked] = useState<string>()
  const focus = charted.find((item) => item.key === picked) ?? charted[0]

  return (
    <>
      <dl className="mt-6 flex flex-wrap items-end gap-x-10 gap-y-3">
        <Stat label="Account value" hero>
          {formatUSD(account.accountValueUsd)}
        </Stat>
        <Stat label="Unrealized PnL">
          <span className={tone(account.unrealizedPnlUsd)}>
            {signed(account.unrealizedPnlUsd)}
          </span>
        </Stat>
        <Stat label="Collateral">{formatUSD(account.collateralUsdc)}</Stat>
        <Stat label="Leverage">
          {account.leverage === null
            ? '—'
            : `${Number(account.leverage).toFixed(2)}×`}
        </Stat>
        {account.riskState && account.riskState !== 'healthy' && (
          <Stat label="Margin">
            <span className="text-bad capitalize">{account.riskState}</span>
          </Stat>
        )}
      </dl>

      {focus ? (
        <TradeCard
          account={account}
          charted={charted}
          focus={focus}
          onFocus={setPicked}
          reader={reader}
        />
      ) : (
        <p className="d-empty mt-5 font-mono text-[13px]">
          No open positions or orders.
        </p>
      )}

      <section className="mt-9" aria-label="Positions">
        <SectionHead title="Positions">
          <span className="d-label normal-case">
            {account.positions.length} open
          </span>
        </SectionHead>
        <Positions
          positions={account.positions}
          focus={focus?.key}
          onFocus={setPicked}
        />
      </section>
      <section className="mt-9" aria-label="Open orders">
        <SectionHead title="Open orders">
          <span className="d-label normal-case">
            {account.orders.length} resting
          </span>
        </SectionHead>
        <Orders orders={account.orders} />
      </section>
      <section className="mt-9" aria-label="Fills">
        <SectionHead title="Fills" />
        <Fills wallet={account.wallet} reader={reader} />
      </section>
    </>
  )
}

function Stat({
  label,
  hero = false,
  children,
}: {
  label: string
  hero?: boolean
  children: ReactNode
}) {
  return (
    <div>
      <dt className="d-label">{label}</dt>
      <dd
        className={`mt-1 font-mono font-semibold tracking-tight ${hero ? 'text-[2rem] leading-none tracking-[-0.05em]' : 'text-[15px]'}`}
      >
        {children}
      </dd>
    </div>
  )
}

function TradeCard({
  account,
  charted,
  focus,
  onFocus,
  reader,
}: {
  account: PhoenixAccount
  charted: Charted[]
  focus: Charted
  onFocus: (key: string) => void
  reader: PhoenixReader
}) {
  // Daily first, as trading screens open.
  const [interval, setCandleInterval] = useState<PhoenixCandleInterval>('1d')
  // Candles first; levels far from price would flatten them.
  const [fitLiquidation, setFitLiquidation] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  const candles = useQuery({
    queryKey: ['phoenix-candles', reader.viewer, focus.symbol, interval],
    queryFn: () => reader.candles(focus.symbol, interval),
    refetchInterval: 60_000,
  })
  const position = focus.position
  const orders = useMemo(
    () =>
      account.orders.filter(
        (each) =>
          each.symbol === focus.symbol && each.subaccount === focus.subaccount,
      ),
    [account.orders, focus],
  )
  const lines = useMemo(() => {
    const levels: ChartLine[] = []
    if (position?.entryPrice)
      levels.push({
        price: Number(position.entryPrice),
        title: 'Entry',
        tone: 'entry',
      })
    if (position?.liquidationPrice)
      levels.push({
        price: Number(position.liquidationPrice),
        title: 'Liquidation',
        tone: 'liquidation',
      })
    for (const order of orders)
      levels.push({
        price: Number(order.price),
        title: `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.type}`,
        tone: 'order',
      })
    return levels
  }, [position, orders])

  return (
    <div className="d-card mt-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4">
        <div
          role="group"
          aria-label="Market"
          className="-mb-px flex max-w-full gap-0.5 overflow-x-auto"
        >
          {charted.map((item) => {
            const side = item.position?.side
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.key === focus.key}
                onClick={() => onFocus(item.key)}
                className="h-11 shrink-0 border-b-2 border-transparent px-2.5 font-mono text-[13px] whitespace-nowrap text-fg-3 hover:text-fg aria-pressed:border-fg aria-pressed:font-semibold aria-pressed:text-fg"
              >
                {perpMarket(item.symbol)}
                {item.subaccount !== 0 && (
                  <span className="ml-1.5 text-[11px] text-fg-3">isolated</span>
                )}
                {side && (
                  <span
                    className={`ml-1.5 text-[11.5px] font-semibold ${side === 'long' ? 'text-live' : 'text-bad'}`}
                  >
                    {side === 'long' ? 'Long' : 'Short'}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2 py-1.5">
          {position?.liquidationPrice && (
            <button
              type="button"
              className="d-btn d-btn-sm"
              aria-pressed={fitLiquidation}
              onClick={() => setFitLiquidation(!fitLiquidation)}
            >
              {fitLiquidation ? 'Hide liquidation' : 'Show liquidation'}
            </button>
          )}
          <button
            type="button"
            className="d-btn d-btn-sm"
            onClick={() => setResetKey(resetKey + 1)}
          >
            Reset view
          </button>
          <div className="d-seg" role="group" aria-label="Candle interval">
            {PHOENIX_CANDLE_INTERVALS.map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={each === interval}
                onClick={() => setCandleInterval(each)}
              >
                {each === '15m' ? each : each.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col">
          {candles.data ? (
            <PerpChart
              market={`${focus.key} ${interval}`}
              candles={candles.data.candles}
              lines={lines}
              fitLiquidation={fitLiquidation}
              resetKey={resetKey}
            />
          ) : candles.isError ? (
            <p className="grid h-[388px] place-items-center font-mono text-[12.5px] text-fg-3">
              Candles could not be read right now.
            </p>
          ) : (
            <Skeleton className="m-4 h-[356px]" />
          )}
          <p className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-4 py-2.5 font-mono text-[12px] text-fg-2">
            {lines.map((line) => (
              <span key={`${line.tone}-${line.price}`}>
                <i
                  aria-hidden="true"
                  className={`mr-1.5 inline-block w-3.5 align-middle ${line.tone === 'liquidation' ? 'border-t-2 border-bad' : line.tone === 'entry' ? 'border-t-[1.5px] border-dashed border-fg-2' : 'border-t-[1.5px] border-dotted border-fg-3'}`}
                />
                {line.title} {formatPrice(line.price)}
              </span>
            ))}
            <span className="ml-auto text-[11px] text-fg-3">
              Drag to pan · scroll to zoom · drag an axis to scale
            </span>
          </p>
        </div>
        <PositionPanel position={position} orders={orders} />
      </div>
    </div>
  )
}

/** How far the mark is from liquidation, as a share of the mark. */
function roomToLiquidation(position: PhoenixPosition) {
  const mark = Number(position.markPrice)
  const liquidation = Number(position.liquidationPrice)
  if (!position.markPrice || !position.liquidationPrice || !(mark > 0))
    return null
  return Math.abs(liquidation - mark) / mark
}

function PositionPanel({
  position,
  orders,
}: {
  position: PhoenixPosition | undefined
  orders: PhoenixOrder[]
}) {
  if (!position)
    return (
      <aside className="border-t border-line p-5 lg:border-t-0 lg:border-l">
        <p className="d-label">Your position</p>
        <p className="mt-2 font-mono text-[13px] text-fg-3">
          No open position here; only resting orders.
        </p>
      </aside>
    )
  const long = position.side === 'long'
  const room = roomToLiquidation(position)
  const facts: Array<[string, ReactNode]> = [
    ['Entry', price(position.entryPrice)],
    ['Mark', price(position.markPrice)],
    [
      'Liquidation',
      position.liquidationPrice ? (
        <>
          {price(position.liquidationPrice)}
          {room !== null && (
            <small className="block text-[11px] font-normal text-fg-3">
              {(room * 100).toFixed(0)}% {long ? 'below' : 'above'} mark
            </small>
          )}
        </>
      ) : (
        'None'
      ),
    ],
    ['Value', position.valueUsd ? formatUSD(position.valueUsd) : '—'],
    ['Funding', formatUSD(position.fundingUsdc, { signed: true })],
    ...orders.map((order): [string, ReactNode] => [
      'Open order',
      `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.size} at ${price(order.price)}`,
    ]),
  ]
  return (
    <aside className="border-t border-line p-5 lg:border-t-0 lg:border-l">
      <p className="d-label">
        Your position
        {position.marginMode === 'isolated' && ' · isolated'}
      </p>
      <p className="mt-2 font-mono text-[18px] font-semibold tracking-tight">
        <span className={long ? 'text-live' : 'text-bad'}>
          {long ? 'Long' : 'Short'}
        </span>{' '}
        {position.size} {position.symbol}
      </p>
      <p
        className={`font-mono text-[26px] leading-tight font-semibold tracking-[-0.04em] ${tone(position.unrealizedPnlUsd)}`}
      >
        {signed(position.unrealizedPnlUsd)}
      </p>
      {room !== null && <RoomBar position={position} room={room} />}
      <dl className="mt-4 grid grid-cols-[auto_1fr] border-t border-line">
        {facts.map(([label, value], index) => (
          <div key={`${label}-${index}`} className="contents">
            <dt
              className={`border-b border-line py-2 font-mono text-[11px] tracking-[0.06em] uppercase ${label === 'Liquidation' ? 'text-bad' : 'text-fg-3'}`}
            >
              {label}
            </dt>
            <dd className="border-b border-line py-2 text-right font-mono text-[13px] font-semibold">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}

/** Liquidation, entry and mark on one honest scale: how much room is left. */
function RoomBar({
  position,
  room,
}: {
  position: PhoenixPosition
  room: number
}) {
  const long = position.side === 'long'
  const mark = Number(position.markPrice)
  const entry = Number(position.entryPrice ?? position.markPrice)
  const liquidation = Number(position.liquidationPrice)
  const [low, high] = long
    ? [liquidation, Math.max(mark, entry) * 1.02]
    : [Math.min(mark, entry) * 0.98, liquidation]
  const at = (value: number) =>
    Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100))
  return (
    <div className="mt-4">
      <p className="d-label">
        Room to liquidation{' '}
        <b className="ml-1 font-semibold text-fg">{(room * 100).toFixed(0)}%</b>
      </p>
      <div className="relative mt-2.5 h-2.5 rounded-full bg-panel-2">
        <span
          className="absolute inset-y-0 rounded-full bg-[color-mix(in_srgb,var(--d-accent)_22%,transparent)]"
          style={{
            left: `${Math.min(at(mark), at(liquidation))}%`,
            right: `${100 - Math.max(at(mark), at(liquidation))}%`,
          }}
        />
        <i
          className="absolute -top-1 h-[18px] w-0.5 -translate-x-1/2 rounded-sm bg-bad"
          style={{ left: `${at(liquidation)}%` }}
        />
        <i
          className="absolute -top-1 h-[18px] w-0.5 -translate-x-1/2 rounded-sm bg-fg-3"
          style={{ left: `${at(entry)}%` }}
        />
        <i
          className="absolute top-0 size-2.5 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_0_2px_var(--d-panel)]"
          style={{ left: `${at(mark)}%` }}
        />
      </div>
      <p className="mt-1.5 flex justify-between font-mono text-[11px] text-fg-3">
        <span>
          {long
            ? `Liq ${price(position.liquidationPrice)}`
            : `Mark ${price(position.markPrice)}`}
        </span>
        <span>
          {long
            ? `Mark ${price(position.markPrice)}`
            : `Liq ${price(position.liquidationPrice)}`}
        </span>
      </p>
    </div>
  )
}

function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="d-card overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[13px]">
        <thead className="d-th">
          <tr className="h-9 text-left [&>th]:px-3.5 [&>th]:font-medium [&>th]:whitespace-nowrap">
            {head}
          </tr>
        </thead>
        <tbody className="[&>tr]:h-[54px] [&>tr]:border-t [&>tr]:border-line [&_td]:px-3.5 [&_td]:whitespace-nowrap">
          {children}
        </tbody>
      </table>
    </div>
  )
}

const TH = 'd-label'

function SideTag({ side }: { side: 'long' | 'short' | 'buy' | 'sell' }) {
  const up = side === 'long' || side === 'buy'
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${up ? 'bg-[color-mix(in_srgb,var(--d-live)_14%,transparent)] text-live' : 'bg-[color-mix(in_srgb,var(--d-bad)_14%,transparent)] text-bad'}`}
    >
      {side[0]?.toUpperCase()}
      {side.slice(1)}
    </span>
  )
}

function Positions({
  positions,
  focus,
  onFocus,
}: {
  positions: PhoenixPosition[]
  focus: string | undefined
  onFocus: (symbol: string) => void
}) {
  if (positions.length === 0)
    return <p className="d-empty font-mono text-[13px]">No open positions.</p>
  return (
    <Table
      head={
        <>
          <th className={TH}>Market</th>
          <th className={`${TH} max-sm:hidden`}>Side</th>
          <th className={`${TH} text-right`}>Size</th>
          <th className={`${TH} text-right max-lg:hidden`}>Entry</th>
          <th className={`${TH} text-right max-lg:hidden`}>Mark</th>
          <th className={`${TH} text-right max-lg:hidden`}>Liquidation</th>
          <th className={`${TH} text-right`}>Unrealized PnL</th>
        </>
      }
    >
      {positions.map((position) => (
        <tr
          key={`${position.subaccount}-${position.symbol}`}
          aria-selected={
            chartKey(position.subaccount, position.symbol) === focus
          }
          onClick={() =>
            onFocus(chartKey(position.subaccount, position.symbol))
          }
          className="cursor-pointer hover:bg-surface aria-selected:bg-surface aria-selected:[&>td:first-child]:shadow-[inset_3px_0_0_var(--d-accent)]"
        >
          <td>
            <b className="font-semibold">{perpMarket(position.symbol)}</b>
            {position.marginMode === 'isolated' && (
              <span className="ml-1.5 text-[11px] text-fg-3">isolated</span>
            )}
            <small
              className={`block text-[11px] sm:hidden ${position.side === 'long' ? 'text-live' : 'text-bad'}`}
            >
              {position.side === 'long' ? 'Long' : 'Short'}
            </small>
          </td>
          <td className="max-sm:hidden">
            <SideTag side={position.side} />
          </td>
          <td className="text-right">
            {position.size} <span className="text-fg-3">{position.symbol}</span>
          </td>
          <td className="text-right max-lg:hidden">
            {price(position.entryPrice)}
          </td>
          <td className="text-right max-lg:hidden">
            {price(position.markPrice)}
          </td>
          <td className="text-right max-lg:hidden">
            {price(position.liquidationPrice)}
          </td>
          <td
            className={`text-right font-semibold ${tone(position.unrealizedPnlUsd)}`}
          >
            {signed(position.unrealizedPnlUsd)}
          </td>
        </tr>
      ))}
    </Table>
  )
}

function Orders({ orders }: { orders: PhoenixOrder[] }) {
  if (orders.length === 0)
    return <p className="d-empty font-mono text-[13px]">No resting orders.</p>
  return (
    <Table
      head={
        <>
          <th className={TH}>Market</th>
          <th className={TH}>Side</th>
          <th className={`${TH} text-right`}>Price</th>
          <th className={`${TH} text-right`}>Size</th>
          <th className={`${TH} max-sm:hidden`}>Reduce only</th>
        </>
      }
    >
      {orders.map((order) => (
        <tr key={`${order.subaccount}-${order.orderId}`}>
          <td>
            <b className="font-semibold">{perpMarket(order.symbol)}</b>
          </td>
          <td>
            <span
              className={`font-semibold ${order.side === 'buy' ? 'text-live' : 'text-bad'}`}
            >
              {order.side === 'buy' ? 'Buy' : 'Sell'}
            </span>{' '}
            <span className="text-fg-3">{order.type}</span>
          </td>
          <td className="text-right">{price(order.price)}</td>
          <td className="text-right">
            {order.size} <span className="text-fg-3">{order.symbol}</span>
          </td>
          <td className="max-sm:hidden">{order.reduceOnly ? 'Yes' : 'No'}</td>
        </tr>
      ))}
    </Table>
  )
}

function Fills({ wallet, reader }: { wallet: string; reader: PhoenixReader }) {
  const fills = useInfiniteQuery({
    queryKey: ['phoenix-fills', reader.viewer, wallet],
    queryFn: ({ pageParam }) => reader.fills(wallet, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const rows = fills.data?.pages.flatMap((page) => page.fills) ?? []
  if (fills.isPending) return <Skeleton className="d-card h-[160px]" />
  if (fills.isError && rows.length === 0)
    return (
      <p className="d-empty font-mono text-[13px]">
        Fills could not be read right now.
      </p>
    )
  if (rows.length === 0)
    return <p className="d-empty font-mono text-[13px]">No fills yet.</p>
  const now = Date.now()
  // Which client placed a fill is known only for the viewer's own requests.
  const signedIn = reader.viewer !== null
  return (
    <>
      <Table
        head={
          <>
            <th className={TH}>Time</th>
            <th className={TH}>Market</th>
            <th className={TH}>Side</th>
            <th className={`${TH} text-right`}>Size</th>
            <th className={`${TH} text-right`}>Price</th>
            <th className={`${TH} text-right max-lg:hidden`}>Realized</th>
            {signedIn && <th className={`${TH} max-lg:hidden`}>Placed by</th>}
            <th className={`${TH} max-lg:hidden`}>Signature</th>
          </>
        }
      >
        {rows.map((fill, index) => {
          const realized = Number(fill.realizedPnlUsdc)
          const url = fill.signature
            ? explorerURL('mainnet', fill.signature)
            : null
          return (
            <tr key={`${fill.signature ?? 'fill'}-${index}`}>
              <td className="text-fg-3">
                {dayLabel(fill.time, now)} {formatTime(fill.time)}
              </td>
              <td>
                <b className="font-semibold">{perpMarket(fill.symbol)}</b>
              </td>
              <td>
                <span
                  className={`font-semibold ${fill.side === 'buy' ? 'text-live' : 'text-bad'}`}
                >
                  {fill.side === 'buy' ? 'Buy' : 'Sell'}
                </span>
              </td>
              <td className="text-right">{fill.size}</td>
              <td className="text-right">{formatPrice(fill.price)}</td>
              <td
                className={`text-right max-lg:hidden ${realized ? (realized < 0 ? 'text-bad' : 'text-live') : 'text-fg-3'}`}
              >
                {realized ? formatUSD(realized, { signed: true }) : '—'}
              </td>
              {signedIn && (
                <td className="font-sans text-[12.5px] max-lg:hidden">
                  {fill.placedBy ? (
                    <b className="font-semibold text-fg">{fill.placedBy}</b>
                  ) : (
                    <span className="text-fg-3">Outside LanaTools</span>
                  )}
                </td>
              )}
              <td className="max-lg:hidden">
                {fill.signature && url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-fg-3 underline decoration-line underline-offset-[3px] hover:text-accent"
                  >
                    {shortAddress(fill.signature)} ↗
                  </a>
                ) : (
                  <span className="text-fg-3">—</span>
                )}
              </td>
            </tr>
          )
        })}
      </Table>
      {fills.hasNextPage && (
        <p className="pt-4 text-center">
          <button
            type="button"
            className="d-btn d-btn-sm"
            disabled={fills.isFetchingNextPage}
            onClick={() => void fills.fetchNextPage()}
          >
            {fills.isFetchingNextPage ? 'Loading…' : 'Load older fills'}
          </button>
        </p>
      )}
    </>
  )
}
