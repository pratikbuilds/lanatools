import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ACTIVITY_CHART_DAYS, formatUsd } from '@lanatools/contracts'
import type {
  ActivityDays,
  ActivityItem,
  ActivityPage as Page,
} from '@lanatools/contracts'
import { CopyStatus, copyLabel, useCopy } from '#/components/landing/copy-url'
import {
  ACTIVITY_OUTCOMES,
  OUTCOME_LABELS,
  CREDIT_ESTIMATE_NOTE,
  callHost,
  callTitle,
  formatCredits,
  dayLabel,
  explorerURL,
  formatTime,
  listActivity,
  listActivityDays,
} from '#/lib/activity'
import type { ActivityFilter } from '#/lib/activity'
import { listMcpClients } from '#/lib/mcp-clients'
import { Drawer, DrawerFacts, DrawerHeader } from './drawer'
import { useDashboardSession } from './session'

const DAY_MS = 86_400_000
const ROW =
  'grid grid-cols-[4.6rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 md:grid-cols-[4.6rem_6.5rem_minmax(0,1fr)_4rem_9rem] md:gap-x-5'
const PROTOCOL_LABELS = { mpp: 'MPP', x402: 'x402' }

function clientName(item: ActivityItem) {
  return item.clientName ?? 'Unknown client'
}

/** The five latest calls on the Wallet page, with the way to all of them. */
export function LatestActivity({ onViewAll }: { onViewAll: () => void }) {
  const { userId, getAccessToken } = useDashboardSession()
  const latest = useQuery({
    queryKey: ['activity-latest', userId],
    queryFn: () =>
      listActivity(getAccessToken, {
        client: undefined,
        outcome: undefined,
        before: undefined,
      }),
    refetchInterval: 15_000,
  })
  const [open, setOpen] = useState<ActivityItem>()
  const items = latest.data?.items.slice(0, 5)

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b-[1.5px] border-ink pb-3">
        <h2 className="text-[15px] font-bold">Latest activity</h2>
        {items && items.length > 0 && (
          <button
            type="button"
            className="text-[12.5px] font-semibold underline underline-offset-[3px]"
            onClick={onViewAll}
          >
            View all activity
          </button>
        )}
      </div>
      {latest.isPending ? (
        <CallSkeleton />
      ) : latest.isError ? (
        <LoadError onRetry={() => void latest.refetch()} />
      ) : items && items.length > 0 ? (
        <>
          <CallHead />
          <CallRows items={items} onOpen={setOpen} />
        </>
      ) : (
        <NoCalls />
      )}
      <CallDrawer item={open} onClose={() => setOpen(undefined)} />
    </section>
  )
}

/** Every call, newest first, with what the filters select totalled above. */
export function ActivityPage({
  filter,
  onFilter,
}: {
  filter: ActivityFilter
  onFilter: (filter: ActivityFilter) => void
}) {
  const { userId, getAccessToken } = useDashboardSession()
  const calls = useInfiniteQuery({
    queryKey: ['activity', userId, filter],
    queryFn: ({ pageParam }) =>
      listActivity(getAccessToken, { ...filter, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  })
  const days = useQuery({
    queryKey: ['activity-days', userId],
    queryFn: () => listActivityDays(getAccessToken),
    refetchInterval: 15_000,
  })
  const clients = useQuery({
    queryKey: ['mcp-clients', userId],
    queryFn: () => listMcpClients(getAccessToken),
  })
  const [open, setOpen] = useState<ActivityItem>()
  const items = calls.data?.pages.flatMap((page) => page.items)
  const filtered = filter.client !== undefined || filter.outcome !== undefined

  return (
    <>
      <h1 className="pt-9 text-[22px] font-bold tracking-[-0.03em]">
        Activity
      </h1>
      <div className="flex flex-wrap items-end justify-between gap-x-14 gap-y-6 py-7">
        <ActivityTotals totals={calls.data?.pages[0]?.totals} />
        {days.data && <ActivityHeatmap days={days.data} />}
      </div>
      <p className="mb-4 text-[12px] text-mute">{CREDIT_ESTIMATE_NOTE}</p>
      <div className="flex flex-wrap items-center gap-2.5 border-b-[1.5px] border-ink pb-3.5">
        <div
          role="group"
          aria-label="Filter by outcome"
          className="inline-flex max-w-full overflow-x-auto rounded-[6px] border-[1.5px] border-ink"
        >
          {[undefined, ...ACTIVITY_OUTCOMES].map((outcome) => (
            <button
              key={outcome ?? 'all'}
              type="button"
              aria-pressed={filter.outcome === outcome}
              onClick={() => onFilter({ ...filter, outcome })}
              className="h-[30px] shrink-0 border-r-[1.5px] border-ink bg-card px-3 text-[12.5px] last:border-r-0 aria-pressed:bg-ink aria-pressed:font-bold aria-pressed:text-card"
            >
              {outcome ? OUTCOME_LABELS[outcome] : 'All'}
            </button>
          ))}
        </div>
        <select
          aria-label="Filter by client"
          value={filter.client ?? ''}
          onChange={(event) =>
            onFilter({ ...filter, client: event.target.value || undefined })
          }
          className="h-[33px] rounded-[6px] border-[1.5px] border-ink bg-card px-2 text-[12.5px] font-semibold"
        >
          <option value="">All clients</option>
          {clients.data?.map((client) => (
            <option key={client.clientId} value={client.clientId}>
              {client.clientName ?? 'Unknown client'}
            </option>
          ))}
          {/* A disconnected client is no longer listed but can still be filtered on. */}
          {filter.client &&
            !clients.data?.some((c) => c.clientId === filter.client) && (
              <option value={filter.client}>{filter.client}</option>
            )}
        </select>
      </div>

      {calls.isPending ? (
        <CallSkeleton />
      ) : calls.isError ? (
        <LoadError onRetry={() => void calls.refetch()} />
      ) : items && items.length > 0 ? (
        <>
          <CallHead />
          <CallRows items={items} onOpen={setOpen} byDay />
          {calls.hasNextPage ? (
            <LoadMore
              loading={calls.isFetchingNextPage}
              onReach={() => void calls.fetchNextPage()}
            />
          ) : (
            <p className="pt-6 text-center text-[12px] text-mute">
              That is every call.
            </p>
          )}
        </>
      ) : filtered ? (
        <p className="pt-6 text-center text-[12px] text-mute">
          No calls match these filters.
        </p>
      ) : (
        <NoCalls />
      )}
      <CallDrawer item={open} onClose={() => setOpen(undefined)} />
    </>
  )
}

export function ActivityTotals({
  totals,
}: {
  totals: Page['totals'] | undefined
}) {
  return (
    <dl className="flex flex-wrap gap-x-14 gap-y-5">
      {(
        [
          ['Spent', totals && formatUsd(totals.spentMicroUsd)],
          ['Calls', totals?.calls.toLocaleString('en-US')],
          [
            'Estimated credits',
            totals?.estimatedCredits.toLocaleString('en-US'),
          ],
        ] as const
      ).map(([label, value]) => (
        <div key={label}>
          <dt className="mb-1.5 text-[12px] text-mute">{label}</dt>
          <dd className="text-[1.6rem] leading-[1.1] font-bold tracking-[-0.03em]">
            {value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const HEAT = ['bg-rule', 'bg-paper-2', 'bg-paper-3', 'bg-blue', 'bg-ink']
const CHART_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/** One square per day for the charted window, darker for more calls. */
export function ActivityHeatmap({
  days,
  now = Date.now(),
}: {
  days: ActivityDays['days']
  now?: number
}) {
  const byDay = new Map(days.map((day) => [day.day, day]))
  const most = Math.max(1, ...days.map((day) => day.calls))
  const today = now - (now % DAY_MS)
  const cells = Array.from({ length: ACTIVITY_CHART_DAYS }, (_, index) => {
    const time = today - (ACTIVITY_CHART_DAYS - 1 - index) * DAY_MS
    const day = byDay.get(new Date(time).toISOString().slice(0, 10))
    return { time, calls: day?.calls ?? 0, spent: day?.spentMicroUsd ?? 0 }
  })

  return (
    <figure>
      <div
        role="img"
        aria-label={`Calls per day over the last ${ACTIVITY_CHART_DAYS / 7} weeks`}
        className="grid grid-flow-col grid-rows-7 gap-[3px]"
      >
        {cells.map((cell) => (
          <span
            key={cell.time}
            title={`${CHART_DAY.format(cell.time)}: ${cell.calls} ${cell.calls === 1 ? 'call' : 'calls'}, ${formatUsd(cell.spent)} spent`}
            className={`size-[9px] rounded-[2px] ${HEAT[Math.ceil((cell.calls / most) * 4)] ?? 'bg-ink'}`}
          />
        ))}
      </div>
      <figcaption className="mt-1.5 text-[12px] text-mute">
        Calls per day, last {ACTIVITY_CHART_DAYS / 7} weeks
      </figcaption>
    </figure>
  )
}

function CallHead() {
  return (
    <div
      aria-hidden="true"
      className={`${ROW} hidden h-[34px] border-b border-rule text-[12px] text-mute md:grid`}
    >
      <span>Time</span>
      <span>Client</span>
      <span>Request</span>
      <span>Source</span>
      <span className="text-right">Outcome</span>
    </div>
  )
}

export function CallRows({
  items,
  onOpen,
  byDay = false,
  now = Date.now(),
}: {
  items: ActivityItem[]
  onOpen: (item: ActivityItem) => void
  /** Puts a day heading above the first call of each day. */
  byDay?: boolean
  now?: number
}) {
  let day: string | undefined
  return (
    <ul>
      {items.map((item) => {
        const label = dayLabel(item.createdAt, now)
        const heading = byDay && label !== day
        day = label
        return (
          <li key={`${item.kind}:${item.id}`}>
            {heading && (
              <h3 className="border-b border-rule px-1 pt-5 pb-2 text-[12px] font-bold">
                {label}
              </h3>
            )}
            <button
              type="button"
              onClick={() => onOpen(item)}
              className={`${ROW} min-h-[46px] w-full border-b border-rule py-2 text-left hover:bg-card`}
            >
              <span className="text-[12px] text-mute">
                {formatTime(item.createdAt)}
              </span>
              <span className="hidden truncate md:block">
                {clientName(item)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-mute">
                  <b className="font-semibold text-ink">
                    {item.kind === 'tool' ? item.tool : callHost(item)}
                  </b>
                  {item.kind === 'payment' && item.path}
                </span>
                {item.reason && (
                  <span
                    className={`block truncate text-[12px] ${item.outcome === 'refused' ? 'text-coral-ink' : 'text-mute'}`}
                  >
                    {item.reason}
                  </span>
                )}
              </span>
              <span className="hidden text-[12px] text-mute md:block">
                {item.kind === 'tool'
                  ? item.provider === 'helius'
                    ? 'Helius'
                    : item.provider
                  : item.protocol && PROTOCOL_LABELS[item.protocol]}
              </span>
              <span className="text-right text-[12.5px] whitespace-nowrap text-mute">
                <Outcome item={item} />
                {item.kind === 'tool' && (
                  <span
                    className="block max-w-[9rem] text-[11px] whitespace-normal"
                    title={CREDIT_ESTIMATE_NOTE}
                  >
                    {formatCredits(item.estimatedCredits)}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Lime is money that moved, coral is a refusal, grey is neither. */
function Outcome({ item }: { item: ActivityItem }) {
  if (
    item.kind === 'payment' &&
    item.outcome === 'paid' &&
    item.amountMicroUsd !== null
  )
    return (
      <span className="rounded-[4px] bg-lime px-[7px] py-0.5 text-[13.5px] font-bold text-ink">
        {formatUsd(item.amountMicroUsd)}
      </span>
    )
  if (item.outcome === 'refused')
    return (
      <span className="rounded-[4px] bg-coral px-[7px] py-0.5 font-bold text-ink">
        Refused
      </span>
    )
  return OUTCOME_LABELS[item.outcome]
}

function CallDrawer({
  item,
  onClose,
}: {
  item: ActivityItem | undefined
  onClose: () => void
}) {
  return (
    <Drawer
      open={item !== undefined}
      onClose={onClose}
      label={item ? `Call: ${callTitle(item)}` : 'Call'}
    >
      {item && <CallDetail item={item} onClose={onClose} />}
    </Drawer>
  )
}

export function CallDetail({
  item,
  onClose,
  now = Date.now(),
}: {
  item: ActivityItem
  onClose: () => void
  now?: number
}) {
  const facts: Array<[string, ReactNode]> = [
    item.kind === 'tool'
      ? ['Tool', item.tool]
      : ['Request', `${item.method} ${item.origin}${item.path}`],
    [
      'Client',
      item.connected ? clientName(item) : `${clientName(item)}, disconnected`,
    ],
  ]
  if (item.kind === 'tool') {
    facts.push([
      'Provider',
      item.provider === 'helius' ? 'Helius' : item.provider,
    ])
    if (item.network) facts.push(['Network', item.network])
    facts.push(['Duration', `${item.durationMs.toLocaleString('en-US')} ms`])
  }
  if (item.kind === 'payment' && item.protocol)
    facts.push([
      'Protocol',
      item.network
        ? `${PROTOCOL_LABELS[item.protocol]}, USDC on ${item.network}`
        : PROTOCOL_LABELS[item.protocol],
    ])
  if (item.kind === 'payment' && item.httpStatus)
    facts.push(['Endpoint answered', `HTTP ${item.httpStatus}`])

  return (
    <>
      <DrawerHeader
        title={callTitle(item)}
        detail={`${clientName(item)}, ${dayLabel(item.createdAt, now)} at ${formatTime(item.createdAt)}`}
        onClose={onClose}
      />
      <p className="text-[12px] text-mute">{OUTCOME_LABELS[item.outcome]}</p>
      <p className="mt-1.5 mb-1 text-[3.2rem] leading-none font-bold tracking-[-0.05em]">
        {item.kind === 'tool'
          ? item.estimatedCredits.toLocaleString('en-US')
          : formatUsd(item.amountMicroUsd ?? 0)}
      </p>
      {item.kind === 'tool' && (
        <p className="mt-2 text-[12px] text-mute">
          Estimated credits. Helius does not report a per-call cost.
        </p>
      )}
      {item.reason && (
        <p
          className={`text-[12px] ${item.outcome === 'refused' ? 'text-coral-ink' : 'text-mute'}`}
        >
          {item.reason}
        </p>
      )}
      <DrawerFacts facts={facts} />
      {item.kind === 'payment' && item.signature && (
        <Transaction signature={item.signature} network={item.network} />
      )}
    </>
  )
}

function Transaction({
  signature,
  network,
}: {
  signature: string
  network: string | null
}) {
  const { state, copy } = useCopy(signature)
  const url = explorerURL(network, signature)
  return (
    <div className="mt-5">
      <p className="text-[12px] text-mute">Transaction</p>
      <p className="mt-1 font-semibold break-all">{signature}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] font-semibold">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-[3px]"
          >
            View on Solana Explorer
          </a>
        )}
        <button
          type="button"
          className="underline underline-offset-[3px]"
          onClick={() => void copy()}
        >
          {copyLabel(state, 'Copy signature')}
        </button>
        <CopyStatus state={state} subject="signature" />
      </div>
    </div>
  )
}

/** Asks for the next page once the end of the list scrolls into view. */
function LoadMore({
  loading,
  onReach,
}: {
  loading: boolean
  onReach: () => void
}) {
  const ref = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const sentinel = ref.current
    // While a page is loading nothing watches, so one reach asks once.
    if (!sentinel || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onReach()
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loading, onReach])

  return (
    <p ref={ref} className="pt-6 text-center text-[12px] text-mute">
      Loading older calls…
    </p>
  )
}

function CallSkeleton() {
  return (
    <span className="mt-3 block h-[140px] animate-pulse rounded-[8px] bg-card" />
  )
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <p role="alert" className="pt-5 text-[13px] text-coral-ink">
      Could not load activity.{' '}
      <button
        type="button"
        className="font-semibold underline underline-offset-[3px]"
        onClick={onRetry}
      >
        Try again
      </button>
    </p>
  )
}

function NoCalls() {
  return (
    <div className="px-1 pt-10 pb-2 text-center">
      <h3 className="text-[15px] font-bold">No calls yet</h3>
      <p className="mt-1.5 text-[12px] text-mute">
        Ask a connected client to read Solana data or call a paid endpoint. Tool
        calls show estimated credits; payments show what they cost.
      </p>
    </div>
  )
}
