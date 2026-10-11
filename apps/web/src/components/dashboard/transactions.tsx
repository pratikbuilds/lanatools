import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PerpTrade,
  SwapTrade,
  TransactionActivityItem,
  TransactionReceipt,
  TransactionStatusGroup,
  TransactionsPage as Page,
} from '@lanatools/contracts'
import { CopyStatus, copyLabel, useCopy } from '#/components/landing/copy-url'
import { dayLabel, explorerURL, formatTime } from '#/lib/activity'
import {
  DELIVERIES,
  DELIVERY_LABELS,
  EMPTY_FILTER,
  KINDS,
  KIND_LABELS,
  STATUS_GROUPS,
  STATUS_LABELS,
  STATUS_NOTES,
  getTransaction,
  listTransactions,
  shortAddress,
  statusGroup,
  syncTransactions,
  transactionAmounts,
  transactionDetail,
  transactionTitle,
} from '#/lib/transactions'
import type { TransactionsFilter } from '#/lib/transactions'
import {
  awaitingFacts,
  formatUSD,
  orderTicket,
  perpNotional,
  swapRate,
  tradeOf,
} from '#/lib/trades'
import { Transaction as SignatureBlock } from './activity'
import { Drawer, DrawerFacts, DrawerHeader } from './drawer'
import { PageHead } from './page-head'
import { useDashboardSession } from './session'
import { useMcpClients } from './use-mcp-clients'

// Time, what and with whom, who started it, how much, and the chain's record.
// On a phone only time, what and how much remain; the drawer has the rest.
const COLUMNS =
  'grid-cols-[4.4rem_minmax(0,1fr)_auto] gap-x-3 lg:grid-cols-[5rem_minmax(0,1fr)_11rem_9.5rem_7rem] lg:gap-x-4'

/** Every transaction, newest first, with status tabs that count them. */
export function TransactionsPage({
  filter,
  onFilter,
}: {
  filter: TransactionsFilter
  onFilter: (filter: TransactionsFilter) => void
}) {
  const { userId, getAccessToken } = useDashboardSession()
  const list = useInfiniteQuery({
    queryKey: ['transactions', userId, filter],
    queryFn: ({ pageParam }) =>
      listTransactions(getAccessToken, { ...filter, before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A poll refetches every loaded page in turn, so it stops once more
    // than the first page is loaded.
    refetchInterval: (query) =>
      (query.state.data?.pages.length ?? 0) > 1 ? false : 15_000,
    placeholderData: keepPreviousData,
  })
  const queryClient = useQueryClient()
  // Deposits are found on chain, not recorded, so the page asks for a sync
  // when it opens and when it comes back into focus.
  const sync = useQuery({
    queryKey: ['transactions-sync', userId],
    queryFn: () => syncTransactions(getAccessToken),
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    // A long history comes in batches; keep asking until it is caught up.
    refetchInterval: (query) => (query.state.data?.more ? 250 : false),
    retry: false,
  })
  useEffect(() => {
    if (sync.data && sync.data.inserted + sync.data.settled > 0)
      void queryClient.invalidateQueries({ queryKey: ['transactions', userId] })
  }, [sync.data, queryClient, userId])
  const clients = useMcpClients()
  const [open, setOpen] = useState<TransactionActivityItem>()
  const items = useMemo(
    () => list.data?.pages.flatMap((page) => page.items),
    [list.data],
  )
  const filtered = Object.values(filter).some((value) => value !== undefined)

  return (
    <>
      <PageHead title="Transactions" />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5 border-b border-line">
        <StatusTabs
          value={filter.status}
          counts={list.data?.pages[0]?.counts}
          onChange={(status) => onFilter({ ...filter, status })}
        />
        <div className="flex w-full flex-wrap items-center gap-2 pb-2.5 lg:w-auto">
          <select
            aria-label="Filter by kind"
            value={filter.kind ?? ''}
            onChange={(event) =>
              onFilter({
                ...filter,
                kind: KINDS.find((kind) => kind === event.target.value),
              })
            }
            className={`d-input cursor-pointer ${filter.kind ? '' : 'text-fg-3'}`}
          >
            <option value="">All kinds</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by client"
            value={filter.client ?? ''}
            onChange={(event) =>
              onFilter({ ...filter, client: event.target.value || undefined })
            }
            className={`d-input cursor-pointer ${filter.client ? '' : 'text-fg-3'}`}
          >
            <option value="">All clients</option>
            {clients.data?.map((client) => (
              <option key={client.clientId} value={client.clientId}>
                {client.clientName ?? 'Unknown client'}
              </option>
            ))}
            {filter.client &&
              !clients.data?.some((c) => c.clientId === filter.client) && (
                <option value={filter.client}>{filter.client}</option>
              )}
          </select>
          <select
            aria-label="Filter by signing method"
            value={filter.delivery ?? ''}
            onChange={(event) =>
              onFilter({
                ...filter,
                delivery: DELIVERIES.find((d) => d === event.target.value),
              })
            }
            className={`d-input cursor-pointer ${filter.delivery ? '' : 'text-fg-3'}`}
          >
            <option value="">Any signing</option>
            {DELIVERIES.map((delivery) => (
              <option key={delivery} value={delivery}>
                {DELIVERY_LABELS[delivery]}
              </option>
            ))}
          </select>
          <AddressField
            value={filter.address}
            onChange={(address) => onFilter({ ...filter, address })}
          />
          {filtered && (
            <button
              type="button"
              className="text-[12.5px] text-fg-3 underline-offset-[3px] hover:text-fg hover:underline"
              onClick={() => onFilter(EMPTY_FILTER)}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="mt-4">
        {list.isPending ? (
          <span className="d-card block h-[140px] animate-pulse" />
        ) : list.isError ? (
          <p role="alert" className="text-[13px] text-bad">
            Could not load transactions.{' '}
            <button
              type="button"
              className="font-semibold underline underline-offset-[3px]"
              onClick={() => void list.refetch()}
            >
              Try again
            </button>
          </p>
        ) : items && items.length > 0 ? (
          <>
            <Ledger>
              <TransactionRows items={items} onOpen={setOpen} />
            </Ledger>
            {list.hasNextPage ? (
              <LoadMore
                loading={list.isFetchingNextPage}
                onReach={() => void list.fetchNextPage()}
              />
            ) : (
              <p className="pt-5 text-center font-mono text-[12px] text-fg-3">
                That is every transaction.
              </p>
            )}
          </>
        ) : filtered ? (
          <p className="d-card px-4 py-[26px] text-center text-fg-3">
            No transactions match these filters.
          </p>
        ) : (
          <div className="d-empty">
            <h3 className="font-mono text-[14px] font-semibold">
              No transactions yet
            </h3>
            <p className="mx-auto mt-1.5 max-w-[34rem] text-fg-3">
              Swaps and transfers an agent prepares, withdrawals you send, and
              deposits to your wallet all show up here, with their status and
              signature.
            </p>
          </div>
        )}
      </div>
      <TransactionDrawer item={open} onClose={() => setOpen(undefined)} />
    </>
  )
}

/** Status is what people scan for, so it is a row of tabs with counts. */
function StatusTabs({
  value,
  counts,
  onChange,
}: {
  value: TransactionStatusGroup | undefined
  counts: Page['counts'] | undefined
  onChange: (status: TransactionStatusGroup | undefined) => void
}) {
  return (
    <div
      role="group"
      aria-label="Filter by status"
      className="-mb-px flex max-w-full gap-0.5 overflow-x-auto"
    >
      {[undefined, ...STATUS_GROUPS].map((status) => (
        <button
          key={status ?? 'all'}
          type="button"
          aria-pressed={value === status}
          onClick={() => onChange(status)}
          className="h-9 shrink-0 border-b-2 border-transparent px-2.5 font-mono text-[13px] whitespace-nowrap text-fg-3 hover:text-fg aria-pressed:border-fg aria-pressed:font-semibold aria-pressed:text-fg"
        >
          {status ? STATUS_LABELS[status] : 'All'}
          {status && counts && counts[status] > 0 && (
            <>
              {' '}
              <span className="ml-1 text-[11px] font-normal text-fg-3">
                {counts[status].toLocaleString('en-US')}
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}

/** Matches a signing wallet or counterparty exactly; typing waits a beat. */
function AddressField({
  value,
  onChange,
}: {
  value: string | undefined
  onChange: (address: string | undefined) => void
}) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  useEffect(() => {
    const next = text.trim() || undefined
    if (next === value) return
    const timer = setTimeout(() => onChange(next), 300)
    return () => clearTimeout(timer)
  }, [text, value, onChange])
  return (
    <input
      type="search"
      aria-label="Filter by address"
      placeholder="Search by address"
      autoComplete="off"
      spellCheck={false}
      value={text}
      onChange={(event) => setText(event.target.value)}
      className="d-input w-full font-mono text-[12.5px] lg:w-[15rem]"
    />
  )
}

/** The ledger: one card with a hatched head over the rows. */
function Ledger({ children }: { children: ReactNode }) {
  return (
    <div className="d-card">
      <div
        aria-hidden="true"
        className={`d-th hidden min-h-9 items-center px-4 lg:grid ${COLUMNS}`}
      >
        <span className="d-label">Time</span>
        <span className="d-label">Transaction</span>
        <span className="d-label">Source</span>
        <span className="d-label text-right">Amount</span>
        <span className="d-label">Signature</span>
      </div>
      {children}
    </div>
  )
}

export const TransactionRows = memo(function TransactionRows({
  items,
  onOpen,
  now = Date.now(),
}: {
  items: TransactionActivityItem[]
  onOpen: (item: TransactionActivityItem) => void
  now?: number
}) {
  const perDay = new Map<string, number>()
  for (const item of items) {
    const label = dayLabel(item.createdAt, now)
    perDay.set(label, (perDay.get(label) ?? 0) + 1)
  }
  let day: string | undefined
  return (
    <ul>
      {items.map((item) => {
        const label = dayLabel(item.createdAt, now)
        const heading = label !== day
        day = label
        const group = statusGroup(item)
        const detail = transactionDetail(item)
        const gone = group === 'failed' || group === 'expired'
        return (
          <li
            key={`${item.kind}:${item.id}`}
            className="[contain-intrinsic-size:auto_58px] [content-visibility:auto]"
          >
            {heading && (
              <h3 className="flex items-baseline gap-2.5 border-t border-line bg-surface px-3.5 py-1.5 lg:px-4">
                <span className="border-b-2 border-fg pb-px font-mono text-[12px] font-semibold">
                  {label}
                </span>
                <span className="d-label normal-case">
                  {perDay.get(label)}{' '}
                  {perDay.get(label) === 1 ? 'transaction' : 'transactions'}
                </span>
              </h3>
            )}
            <div
              className={`grid min-h-[58px] items-center border-t border-line px-3.5 hover:bg-surface lg:px-4 ${COLUMNS}`}
            >
              <button
                type="button"
                onClick={() => onOpen(item)}
                className="col-span-3 grid cursor-pointer grid-cols-subgrid items-center py-2.5 text-left lg:col-span-4"
              >
                <span className="font-mono text-[12px] text-fg-3">
                  {formatTime(item.createdAt)}
                </span>
                <span className="min-w-0">
                  {/* A phone lets the title wrap so its status mark is never cut off. */}
                  <span className="block truncate font-mono text-[13.5px] font-semibold max-lg:whitespace-normal">
                    {transactionTitle(item)}
                    <StatusMark group={group} />
                  </span>
                  {detail && (
                    <span
                      className={`block truncate text-[12px] ${detail.bad ? 'text-bad' : 'text-fg-3'}`}
                    >
                      {detail.text}
                    </span>
                  )}
                </span>
                <span className="hidden truncate text-[12.5px] text-fg-3 lg:block">
                  <Source item={item} />
                </span>
                <span className="text-right whitespace-nowrap">
                  <Amount item={item} muted={gone} />
                </span>
              </button>
              <span className="hidden min-w-0 lg:block">
                {item.signature && (
                  <SignatureLink
                    signature={item.signature}
                    network={item.network}
                  />
                )}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
})

/** Confirmed is the quiet default; only the exceptions get a mark. */
function StatusMark({ group }: { group: TransactionStatusGroup }) {
  if (group === 'confirmed') return null
  const look = {
    pending: 'border border-accent text-accent',
    failed: 'bg-bad text-on-bad',
    expired: 'border border-line text-fg-3',
  }[group]
  return (
    <span
      className={`ml-2 inline-block rounded px-1.5 align-[2px] font-mono text-[11px] font-semibold ${look}`}
    >
      {STATUS_LABELS[group]}
    </span>
  )
}

/** Who started it, and how it was signed. A deposit has no source to name. */
function Source({ item }: { item: TransactionActivityItem }) {
  if (item.kind === 'agent')
    return (
      <>
        <b className="font-semibold text-fg">
          {item.clientName ?? 'Unknown client'}
        </b>
        {' · '}
        {DELIVERY_LABELS[item.delivery]}
      </>
    )
  if (item.kind === 'withdrawal')
    return (
      <>
        <b className="font-semibold text-fg">You</b> · Wallet page
      </>
    )
  return null
}

/** A value set large with its unit small, as amounts are. */
function Unit({ value }: { value: string }) {
  const [, number = value, unit] = /^(\S+)\s+(.+)$/.exec(value) ?? []
  return (
    <>
      {number}
      {unit && (
        <>
          {' '}
          <span className="text-[11.5px] font-medium tracking-normal text-current opacity-70">
            {unit}
          </span>
        </>
      )}
    </>
  )
}

/**
 * Money that arrived is lime; everything else is set large with its unit
 * small. A swap shows what came back under what it paid. A perp order moves
 * no wallet money, so it shows its notional, unsigned and quiet.
 */
function Amount({
  item,
  muted,
}: {
  item: TransactionActivityItem
  muted: boolean
}) {
  const amounts = transactionAmounts(item)
  const trade = tradeOf(item)
  const facts = item.kind === 'agent' ? item.receipt : null
  const notional = trade && perpNotional(trade, facts)
  if (notional && !amounts.out && !amounts.in)
    return (
      <span
        className={`inline-flex flex-col items-end font-mono text-[15px] tracking-tight ${muted ? 'text-fg-3 line-through' : ''}`}
      >
        {notional}
        <span className="text-[11px] font-normal tracking-normal text-fg-3 no-underline">
          notional
        </span>
      </span>
    )
  if (trade?.kind === 'swap' && amounts.out)
    return (
      <span
        className={`inline-flex flex-col items-end font-mono text-[15px] tracking-tight ${muted ? 'font-normal text-fg-3 line-through' : 'font-semibold'}`}
      >
        <span>
          −<Unit value={amounts.out} />
        </span>
        {amounts.in && !muted && (
          <span className="text-[12px] font-medium text-live">
            {facts?.received ? '' : '≈ '}+
            <Unit value={amounts.in} />
          </span>
        )}
      </span>
    )
  const value = amounts.in && !amounts.out ? amounts.in : amounts.out
  if (!value) return <span className="text-fg-3">—</span>
  const sign = amounts.in && !amounts.out ? '+' : '−'
  const inner = (
    <>
      {sign}
      <Unit value={value} />
    </>
  )
  return (
    <span
      className={`inline-block font-mono text-[15px] tracking-tight ${muted ? 'font-normal text-fg-3 line-through' : 'font-semibold'} ${sign === '+' && !muted ? 'rounded-[5px] bg-lime px-2 py-0.5 text-ink' : ''}`}
    >
      {inner}
    </span>
  )
}

/** The chain's own record. It opens Explorer; the rest of the row opens the drawer. */
function SignatureLink({
  signature,
  network,
}: {
  signature: string
  network: string
}) {
  const url = explorerURL(network, signature)
  const text = shortAddress(signature)
  if (!url)
    return <span className="font-mono text-[12px] text-fg-3">{text}</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="View on Solana Explorer"
      className="font-mono text-[12px] text-fg-3 underline decoration-line underline-offset-[3px] hover:text-accent hover:decoration-current"
    >
      {text} ↗
    </a>
  )
}

function TransactionDrawer({
  item,
  onClose,
}: {
  item: TransactionActivityItem | undefined
  onClose: () => void
}) {
  return (
    <Drawer
      open={item !== undefined}
      onClose={onClose}
      label={item ? `Transaction: ${transactionTitle(item)}` : 'Transaction'}
    >
      {item && <LiveTransactionDetail item={item} onClose={onClose} />}
    </Drawer>
  )
}

/**
 * A request that was sent may have moved on since the list was read, so
 * the drawer asks the API to check the chain and keeps asking while it is
 * pending. The list is refreshed once the status changes.
 */
function LiveTransactionDetail({
  item,
  onClose,
}: {
  item: TransactionActivityItem
  onClose: () => void
}) {
  const { userId, getAccessToken } = useDashboardSession()
  const queryClient = useQueryClient()
  const pending = statusGroup(item) === 'pending'
  const fresh = useQuery({
    queryKey: ['transaction', userId, item.id],
    queryFn: () => getTransaction(getAccessToken, item.id),
    // A confirmed trade may not know what filled yet; reading it asks.
    enabled: pending || awaitingFacts(item),
    refetchInterval: (query) =>
      query.state.data && statusGroup(query.state.data) !== 'pending'
        ? false
        : 5_000,
  })
  const current = fresh.data ?? item
  useEffect(() => {
    if (
      fresh.data &&
      (fresh.data.status !== item.status ||
        awaitingFacts(item) !== awaitingFacts(fresh.data))
    )
      void queryClient.invalidateQueries({ queryKey: ['transactions', userId] })
  }, [fresh.data, item, queryClient, userId])
  return (
    <TransactionDetail
      item={current}
      checking={fresh.isFetching}
      onClose={onClose}
    />
  )
}

export function TransactionDetail({
  item,
  checking = false,
  onClose,
  now = Date.now(),
}: {
  item: TransactionActivityItem
  checking?: boolean
  onClose: () => void
  now?: number
}) {
  const { walletAddress } = useDashboardSession()
  const group = statusGroup(item)
  const gone = group === 'failed' || group === 'expired'
  const amounts = transactionAmounts(item)
  const trade = tradeOf(item)
  const order =
    trade?.kind === 'perp' &&
    (trade.action === 'order' || trade.action === 'close')
      ? trade
      : undefined
  const main = order
    ? order.size && `${order.size} ${order.symbol ?? ''}`.trim()
    : amounts.in && !amounts.out
      ? `+${amounts.in}`
      : amounts.out && `−${amounts.out}`
  const who =
    item.kind === 'agent'
      ? (item.clientName ?? 'Unknown client')
      : item.kind === 'withdrawal'
        ? 'You, from the Wallet page'
        : 'Deposit'
  const yours = (address: string) =>
    address === walletAddress ? 'Your LanaTools wallet' : address

  const facts: Array<[string, ReactNode]> = []
  if (item.kind === 'agent') {
    if (trade?.kind === 'swap') {
      const rate = swapRate(trade, item.receipt)
      if (rate) facts.push(['Rate', rate])
      if (trade.receive.minimum)
        facts.push([
          'Minimum receive',
          `${trade.receive.minimum} ${trade.receive.symbol}`,
        ])
      facts.push(['Max slippage', `${trade.maxSlippageBps / 100}%`])
      facts.push(['Route', 'Jupiter'])
    } else if (!trade)
      // The trade already says what these fields do, more plainly.
      for (const field of item.review.fields)
        facts.push([field.label, field.value])
    facts.push(['Kind', `Agent transaction, ${item.tool}`])
    facts.push(['Client', item.connected ? who : `${who}, disconnected`])
    facts.push([
      'Signing',
      {
        link: 'Link, on the review page',
        local: "Local, the agent's own wallet",
        embedded: 'Embedded, no approval',
      }[item.delivery],
    ])
    if (item.account) facts.push(['Signed by', yours(item.account)])
  } else {
    facts.push([item.kind === 'deposit' ? 'From' : 'To', item.counterparty])
    facts.push(['Kind', item.kind === 'deposit' ? 'Deposit' : 'Withdrawal'])
    if (item.kind === 'withdrawal')
      facts.push(['Signed by', 'Your LanaTools wallet'])
  }
  facts.push(['Network', `Solana ${item.network}`])
  if (item.kind === 'agent' && item.receipt)
    facts.push(['Slot', `${item.receipt.slot}, ${item.receipt.commitment}`])
  if (item.kind !== 'agent' && item.slot) facts.push(['Slot', item.slot])
  if (item.kind === 'agent' && item.reason) facts.push(['Error', item.reason])
  if (item.kind === 'agent' && item.reviewUrl)
    facts.push([
      'Expires',
      `${dayLabel(item.expiresAt, now)} at ${formatTime(item.expiresAt)}`,
    ])

  const raw = item.kind === 'agent' ? item.status : item.status
  return (
    <>
      <DrawerHeader
        title={transactionTitle(item)}
        detail={`${who}, ${dayLabel(item.createdAt, now)} at ${formatTime(item.createdAt)}`}
        onClose={onClose}
      />
      <p className="d-label">
        {STATUS_LABELS[group]}
        {raw !== group && (
          <span className="ml-1.5 normal-case opacity-70">
            ({raw.replaceAll('_', ' ')})
          </span>
        )}
      </p>
      {trade?.kind === 'swap' ? (
        <SwapFlow
          trade={trade}
          received={item.kind === 'agent' ? item.receipt?.received : undefined}
          done={group === 'confirmed'}
          gone={gone}
        />
      ) : (
        main && (
          <p
            className={`mt-3 mb-1 font-mono text-[2.6rem] leading-none font-semibold tracking-[-0.05em] ${gone ? 'text-fg-3 line-through' : ''}`}
          >
            {main}
          </p>
        )
      )}
      {order && item.kind === 'agent' && item.receipt?.fill ? (
        <p className="mb-1 font-mono text-[13px] font-medium text-fg-2">
          Filled {item.receipt.fill.size} at{' '}
          {formatUSD(item.receipt.fill.price)} each,{' '}
          {perpNotional(order, item.receipt)} notional
        </p>
      ) : (
        order?.notionalUsd && (
          <p className="mb-1 font-mono text-[13px] font-medium text-fg-2">
            {formatUSD(order.notionalUsd)} notional
            {order.orderType === 'limit' && order.limitPrice
              ? ` at ${formatUSD(order.limitPrice)} each`
              : order.bestPrice
                ? ` at the best price, ${formatUSD(order.bestPrice)}`
                : ''}
          </p>
        )
      )}
      {amounts.in && amounts.out && trade?.kind !== 'swap' && (
        <p className="mb-1 font-mono text-[1.1rem] font-semibold tracking-tight">
          +{amounts.in}
          {group !== 'confirmed' && (
            <span className="font-normal text-fg-3"> expected</span>
          )}
        </p>
      )}
      <p
        className={`text-[12px] ${group === 'failed' ? 'text-bad' : 'text-fg-3'}`}
      >
        {checking
          ? 'Checking the chain…'
          : (STATUS_NOTES[raw] ?? STATUS_NOTES[group] ?? '')}
      </p>
      {trade?.kind === 'perp' && item.kind === 'agent' && (
        <>
          {order && <OrderTicket trade={order} facts={item.receipt} />}
          {item.review.fields
            .filter((field) => field.label === 'Notice')
            .map((field) => (
              <p
                key={field.value}
                className="mt-3 border-l-2 border-line-2 pl-3 text-[12.5px] text-fg-2"
              >
                {field.value}
              </p>
            ))}
          <AccountLink account={item.account} />
        </>
      )}
      <DrawerFacts facts={facts} />
      {item.signature && (
        <SignatureBlock signature={item.signature} network={item.network} />
      )}
      {item.kind === 'agent' && item.reviewUrl && (
        <ReviewLink url={item.reviewUrl} />
      )}
    </>
  )
}

/** What a swap paid and what came back, each with its token's logo. */
function SwapFlow({
  trade,
  received,
  done,
  gone,
}: {
  trade: SwapTrade
  /** The signer's actual net output, once read after confirmation. */
  received: { amount: string } | undefined
  done: boolean
  gone: boolean
}) {
  const legs = [
    {
      label: done ? 'You paid' : 'You pay',
      token: trade.pay,
      amount: trade.pay.amount,
    },
    {
      label: received
        ? 'You received'
        : done
          ? 'You received, estimated'
          : gone
            ? 'Would have received'
            : 'You receive, estimated',
      token: trade.receive,
      amount:
        received?.amount ?? trade.receive.estimated ?? trade.receive.minimum,
    },
  ]
  return (
    <div className="d-inset mt-3">
      {legs.map((leg, index) => (
        <div
          key={leg.label}
          className={`grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 px-4 py-3.5 ${index ? 'border-t border-line' : ''} ${index && done ? 'bg-[color-mix(in_srgb,var(--color-lime)_22%,var(--d-panel))]' : ''}`}
        >
          {leg.token.icon ? (
            <img
              src={leg.token.icon}
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-full"
            />
          ) : (
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-full bg-panel-2 font-mono text-[11px] font-semibold"
            >
              {leg.token.symbol.slice(0, 3)}
            </span>
          )}
          <div className="min-w-0">
            <p className="d-label">{leg.label}</p>
            <p
              className={`truncate font-mono text-[22px] leading-tight font-semibold tracking-tight ${gone ? 'text-fg-3 line-through' : ''}`}
            >
              {leg.amount ? (
                <>
                  {index && !received && leg.amount === trade.receive.estimated
                    ? '≈ '
                    : ''}
                  {leg.amount}{' '}
                  <span className="text-[14px]">{leg.token.symbol}</span>
                </>
              ) : (
                leg.token.symbol
              )}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}

/** A perp order's terms, as an exchange's order ticket lays them out. */
function OrderTicket({
  trade,
  facts,
}: {
  trade: PerpTrade
  facts: TransactionReceipt | null
}) {
  const rows = orderTicket(trade, facts)
  const long = trade.side === 'buy'
  return (
    <div className="d-inset mt-4">
      <div className="flex items-center justify-between gap-3 border-b border-line px-3.5 py-2.5">
        <span className="font-mono text-[13px] font-semibold">
          {trade.action === 'close' ? 'Close' : 'Order'}
        </span>
        {trade.side && (
          <span
            className={`rounded-md px-2 py-0.5 font-mono text-[11.5px] font-semibold ${long ? 'bg-[color-mix(in_srgb,var(--d-live)_14%,transparent)] text-live' : 'bg-[color-mix(in_srgb,var(--d-bad)_14%,transparent)] text-bad'}`}
          >
            {long ? 'Buy' : 'Sell'}
            {trade.closing
              ? ` · closes ${trade.closing}`
              : long
                ? ' · long'
                : ' · short'}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2">
        {rows.map(([label, value], index) => (
          <div
            key={label}
            className={`px-3.5 py-2.5 ${index > 1 ? 'border-t border-line' : ''} ${index % 2 === 0 ? 'border-r border-line' : ''}`}
          >
            <dt className="font-mono text-[10.5px] tracking-[0.06em] text-fg-3 uppercase">
              {label}
            </dt>
            <dd className="mt-0.5 font-mono text-[13px] font-semibold">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** Where a perp transaction's account lives: the wallet that signed it. */
function AccountLink({ account }: { account: string | null }) {
  return (
    <a
      href={account ? `/dashboard/perps/${account}` : '/dashboard/perps'}
      className="mt-4 flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface px-4 py-3 hover:border-fg-3"
    >
      <span className="min-w-0">
        <span className="block font-mono text-[13px] font-semibold">
          Phoenix account
        </span>
        <span className="block truncate font-mono text-[11.5px] text-fg-3">
          {account ? shortAddress(account) : 'Your LanaTools wallet'}
        </span>
      </span>
      <span className="font-mono text-[12px] font-semibold">
        Open account →
      </span>
    </a>
  )
}

function ReviewLink({ url }: { url: string }) {
  const { state, copy } = useCopy(url)
  return (
    <div className="mt-6">
      <p className="d-label">Review link</p>
      <p className="d-well mt-2 text-[12.5px]">{url}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="d-btn d-btn-sm"
        >
          Open review page ↗
        </a>
        <button
          type="button"
          className="d-btn d-btn-sm"
          onClick={() => void copy()}
        >
          {copyLabel(state, 'Copy link')}
        </button>
        <CopyStatus state={state} subject="link" />
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
    if (!sentinel || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onReach()
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loading, onReach])
  return (
    <p ref={ref} className="pt-5 text-center font-mono text-[12px] text-fg-3">
      Loading older transactions…
    </p>
  )
}
