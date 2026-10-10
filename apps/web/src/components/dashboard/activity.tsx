import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
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
import { Drawer, DrawerFacts, DrawerHeader } from './drawer'
import { useDashboardSession } from './session'
import { useMcpClients } from './use-mcp-clients'
import { PageHead, SectionHead } from './page-head'
import { Skeleton } from './skeleton'

const DAY_MS = 86_400_000
const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3.5 lg:grid-cols-[5.5rem_minmax(0,1.7fr)_minmax(0,1fr)_4rem_10rem] lg:gap-x-4 lg:px-4'
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
    <section
      className="mt-9"
      aria-label="Latest activity"
      aria-busy={latest.isPending}
    >
      <SectionHead title="Latest activity">
        {items && items.length > 0 && (
          <button
            type="button"
            className="ml-auto text-[13px] text-fg-2 underline-offset-[3px] hover:text-fg hover:underline"
            onClick={onViewAll}
          >
            View all
          </button>
        )}
      </SectionHead>
      {latest.isPending ? (
        <CallSkeleton />
      ) : latest.isError && !latest.data ? (
        <LoadError onRetry={() => void latest.refetch()} />
      ) : items && items.length > 0 ? (
        <CallTable>
          <CallRows items={items} onOpen={setOpen} />
        </CallTable>
      ) : (
        <NoCalls />
      )}
      {latest.isRefetchError && (
        <LoadError onRetry={() => void latest.refetch()} refreshing />
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
    // A poll refetches every loaded page in turn, so it stops once more
    // than the first page is loaded.
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 0) > 1 ? false : 15_000,
    // Keeps the current rows on screen while a new filter loads.
    placeholderData: keepPreviousData,
  })
  const days = useQuery({
    queryKey: ['activity-days', userId],
    queryFn: () => listActivityDays(getAccessToken),
    refetchInterval: 15_000,
  })
  const clients = useMcpClients()
  const [open, setOpen] = useState<ActivityItem>()
  const items = useMemo(
    () => calls.data?.pages.flatMap((page) => page.items),
    [calls.data],
  )
  const filtered = filter.client !== undefined || filter.outcome !== undefined

  return (
    <>
      <PageHead title="Activity" />
      <div className="d-frame mt-5">
        <div className="d-inset d-pane flex flex-wrap items-end justify-between gap-x-14 gap-y-6">
          <ActivityTotals
            totals={calls.data?.pages[0]?.totals}
            pending={calls.isPending}
          />
          {days.data ? (
            <ActivityHeatmap days={days.data} />
          ) : (
            days.isPending && <HeatmapSkeleton />
          )}
        </div>
      </div>
      <p className="mt-3 text-[12.5px] text-fg-3">{CREDIT_ESTIMATE_NOTE}</p>
      <SectionHead title="Calls" className="mt-9">
        <div className="flex w-full flex-wrap items-center gap-2.5 lg:ml-auto lg:w-auto">
          <div role="group" aria-label="Filter by outcome" className="d-seg">
            {[undefined, ...ACTIVITY_OUTCOMES].map((outcome) => (
              <button
                key={outcome ?? 'all'}
                type="button"
                aria-pressed={filter.outcome === outcome}
                onClick={() => onFilter({ ...filter, outcome })}
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
            className="d-input cursor-pointer"
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
      </SectionHead>

      {calls.isPending ? (
        <CallSkeleton />
      ) : calls.isError && !calls.data ? (
        <LoadError onRetry={() => void calls.refetch()} />
      ) : items && items.length > 0 ? (
        <>
          <CallTable>
            <CallRows items={items} onOpen={setOpen} byDay />
          </CallTable>
          {calls.hasNextPage ? (
            <LoadMore
              loading={calls.isFetchingNextPage}
              onReach={() => void calls.fetchNextPage()}
            />
          ) : (
            <p className="pt-5 text-center font-mono text-[12px] text-fg-3">
              That is every call.
            </p>
          )}
        </>
      ) : filtered ? (
        <p className="d-card px-4 py-[26px] text-center text-fg-3">
          No calls match these filters.
        </p>
      ) : (
        <NoCalls />
      )}
      {calls.isRefetchError && (
        <LoadError onRetry={() => void calls.refetch()} refreshing />
      )}
      <CallDrawer item={open} onClose={() => setOpen(undefined)} />
    </>
  )
}

export function ActivityTotals({
  totals,
  pending = false,
}: {
  totals: Page['totals'] | undefined
  pending?: boolean
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
          <dt className="d-label mb-2">{label}</dt>
          <dd className="font-mono text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.04em]">
            {value ?? (pending ? <Skeleton className="h-[1.1em] w-24" /> : '—')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const HEAT = ['bg-panel-2', 'bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4']
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
            className={`size-[9px] rounded-[2px] ${HEAT[Math.ceil((cell.calls / most) * 4)] ?? HEAT[4]}`}
          />
        ))}
      </div>
      <figcaption className="d-label mt-2 normal-case">
        Calls per day, last {ACTIVITY_CHART_DAYS / 7} weeks
      </figcaption>
    </figure>
  )
}

/** The calls' table: a hatched head over the rows. */
function CallTable({ children }: { children: ReactNode }) {
  return (
    <div className="d-card">
      <div aria-hidden="true" className={`${ROW} d-th hidden min-h-9 lg:grid`}>
        <span className="d-label">Time</span>
        <span className="d-label">Request</span>
        <span className="d-label">Client</span>
        <span className="d-label">Source</span>
        <span className="d-label text-right">Outcome</span>
      </div>
      {children}
    </div>
  )
}

export const CallRows = memo(function CallRows({
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
          <li
            key={`${item.kind}:${item.id}`}
            className="[contain-intrinsic-size:auto_54px] [content-visibility:auto]"
          >
            {heading && (
              <h3 className="d-label flex min-h-[30px] items-center border-t border-line bg-surface px-3.5 lg:px-4">
                {label}
              </h3>
            )}
            <button
              type="button"
              onClick={() => onOpen(item)}
              className={`${ROW} min-h-[54px] w-full cursor-pointer border-t border-line py-2 text-left hover:bg-surface`}
            >
              <span className="font-mono text-[12px] text-fg-3">
                {formatTime(item.createdAt)}
              </span>
              <span className="col-span-2 row-start-2 min-w-0 lg:col-span-1 lg:row-auto">
                <span className="block truncate">
                  <b className="font-semibold">
                    {item.kind === 'tool' ? item.tool : callHost(item)}
                  </b>
                  {item.kind === 'payment' && (
                    <span className="ml-1.5 font-mono text-[12px] text-fg-3">
                      {item.path}
                    </span>
                  )}
                </span>
                {item.reason && (
                  <span
                    className={`block truncate text-[12px] ${item.outcome === 'refused' ? 'text-warn' : 'text-fg-3'}`}
                  >
                    {item.reason}
                  </span>
                )}
              </span>
              <span className="hidden truncate text-fg-2 lg:block">
                {clientName(item)}
              </span>
              <span className="hidden font-mono text-[12px] text-fg-3 lg:block">
                {item.kind === 'tool'
                  ? item.provider === 'helius'
                    ? 'Helius'
                    : item.provider
                  : item.protocol && PROTOCOL_LABELS[item.protocol]}
              </span>
              <span className="col-start-2 row-start-1 text-right font-mono text-[13px] whitespace-nowrap lg:col-auto lg:row-auto">
                <Outcome item={item} />
                {item.kind === 'tool' && (
                  <span
                    className="ml-auto block max-w-[10rem] text-[11px] font-normal whitespace-normal text-fg-3"
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
})

/** Money that moved is bold, a refusal amber, a failure red, the rest faint. */
function Outcome({ item }: { item: ActivityItem }) {
  if (
    item.kind === 'payment' &&
    item.outcome === 'paid' &&
    item.amountMicroUsd !== null
  )
    return (
      <span className="font-semibold">−{formatUsd(item.amountMicroUsd)}</span>
    )
  if (item.outcome === 'refused')
    return <span className="font-semibold text-warn">Refused</span>
  if (item.outcome === 'failed')
    return (
      <span className="font-semibold text-bad">
        Failed
        <span className="font-normal max-lg:hidden"> · not charged</span>
      </span>
    )
  return (
    <span className="font-medium text-fg-3">
      {OUTCOME_LABELS[item.outcome]}
    </span>
  )
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
      <p className="d-label">{OUTCOME_LABELS[item.outcome]}</p>
      <p className="mt-3 mb-2 font-mono text-[3rem] leading-none font-semibold tracking-[-0.05em]">
        {item.kind === 'tool'
          ? item.estimatedCredits.toLocaleString('en-US')
          : formatUsd(item.amountMicroUsd ?? 0)}
      </p>
      {item.kind === 'tool' && (
        <p className="mt-2 text-[12px] text-fg-3">
          Estimated credits. Helius does not report a per-call cost.
        </p>
      )}
      {item.reason && (
        <p
          className={`text-[12px] ${item.outcome === 'refused' ? 'text-warn' : 'text-fg-3'}`}
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

/** A signature in a well, with its Explorer link and a copy button. */
export function Transaction({
  signature,
  network,
}: {
  signature: string
  network: string | null
}) {
  const { state, copy } = useCopy(signature)
  const url = explorerURL(network, signature)
  return (
    <div className="mt-6">
      <p className="d-label">Transaction</p>
      <p className="d-well mt-2 text-[12.5px]">{signature}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="d-btn d-btn-sm"
          >
            View on Solana Explorer ↗
          </a>
        )}
        <button
          type="button"
          className="d-btn d-btn-sm"
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
    <p ref={ref} className="pt-5 text-center font-mono text-[12px] text-fg-3">
      Loading older calls…
    </p>
  )
}

export function HeatmapSkeleton() {
  return <Skeleton className="h-[104px] w-[165px]" />
}

export function CallSkeleton() {
  return (
    <div role="status" aria-label="Loading activity">
      <div aria-hidden="true">
        <CallTable>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className={`${ROW} min-h-[54px] border-t border-line py-2`}
            >
              <Skeleton className="h-3 w-16" />
              <Skeleton className="col-span-2 row-start-2 h-3.5 w-48 max-w-full lg:col-span-1 lg:row-auto" />
              <Skeleton className="hidden h-3.5 w-28 lg:block" />
              <Skeleton className="hidden h-3 w-12 lg:block" />
              <Skeleton className="col-start-2 row-start-1 ml-auto h-3.5 w-20 lg:col-auto lg:row-auto" />
            </div>
          ))}
        </CallTable>
      </div>
    </div>
  )
}

function LoadError({
  onRetry,
  refreshing = false,
}: {
  onRetry: () => void
  refreshing?: boolean
}) {
  return (
    <p role="alert" className="text-[13px] text-bad">
      {refreshing
        ? 'Could not refresh activity. Showing the last loaded data.'
        : 'Could not load activity.'}{' '}
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
    <div className="d-empty">
      <h3 className="font-mono text-[14px] font-semibold">No calls yet</h3>
      <p className="mx-auto mt-1.5 max-w-[34rem] text-fg-3">
        Ask a connected client to read Solana data or call a paid endpoint. Tool
        calls show estimated credits; payments show what they cost.
      </p>
    </div>
  )
}
