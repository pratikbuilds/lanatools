import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatUsd } from '@lanatools/contracts'
import { CREDIT_ESTIMATE_NOTE } from '#/lib/activity'
import type { McpClient } from '@lanatools/contracts'
import { revokeMcpClient, setMcpClientLimit, timeAgo } from '#/lib/mcp-clients'
import { Drawer, DrawerFacts, DrawerHeader } from './drawer'
import { LimitEditor } from './limit-editor'
import { SectionHead } from './page-head'
import { useDashboardSession } from './session'
import { mcpClientsKey, useMcpClients } from './use-mcp-clients'
import { useWalletBalances } from './wallet-panel'

// account:read is on every grant, so it is not listed as a tool.
const TOOL_LABELS: Record<string, string> = {
  'helius:read': 'Helius',
  'payments:pay': 'Pay within its limit',
  'jupiter:read': 'Jupiter',
  'phoenix:read': 'Phoenix',
}

/** The tool families a client may use; the catalog is always included. */
function toolsOf(client: McpClient) {
  const tools = client.scopes.flatMap((scope) => TOOL_LABELS[scope] ?? [])
  return [...tools, 'pay.sh catalog'].join(', ')
}

const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3.5 md:grid-cols-[minmax(9rem,1.5fr)_minmax(9rem,1.7fr)_5.5rem_9.5rem_4.9rem] md:gap-4 md:px-4'
// A client used this recently is shown as working now.
const ACTIVE_MS = 10 * 60_000
// Rows shown before the list folds.
const SHOWN = 6

function clientName(client: McpClient) {
  return client.clientName ?? 'Unknown client'
}

function canPay(client: McpClient) {
  return client.scopes.includes('payments:pay')
}

/**
 * What a client can still spend. A payment whose outcome is not known yet
 * holds its amount back, so this never promises money the client cannot use.
 */
function leftOf(client: McpClient) {
  return Math.max(
    0,
    client.limitMicroUsd - client.spentMicroUsd - client.reservedMicroUsd,
  )
}

type ClientState = 'off' | 'full' | 'near' | 'live' | 'idle'
const STATE_LABELS: Record<ClientState, string> = {
  off: 'Cannot pay',
  full: 'Limit reached',
  near: 'Near limit',
  live: 'Working now',
  idle: 'Idle',
}

function stateOf(client: McpClient, now: number): ClientState {
  if (!canPay(client)) return 'off'
  if (leftOf(client) === 0) return 'full'
  if (leftOf(client) <= client.limitMicroUsd * 0.2) return 'near'
  if (client.lastUsedAt !== null && now - client.lastUsedAt < ACTIVE_MS)
    return 'live'
  return 'idle'
}

type SortKey = 'name' | 'left' | 'last'
const SORTS: Record<SortKey, (a: McpClient, b: McpClient) => number> = {
  name: (a, b) => clientName(a).localeCompare(clientName(b)),
  // Least left first; a client that cannot pay has nothing to run out of.
  left: (a, b) =>
    (canPay(a) ? leftOf(a) : Infinity) - (canPay(b) ? leftOf(b) : Infinity),
  last: (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
}

export function ConnectedClients({
  onViewActivity,
}: {
  onViewActivity: (clientId: string) => void
}) {
  const { userId, walletAddress, getAccessToken } = useDashboardSession()
  const queryClient = useQueryClient()
  const queryKey = mcpClientsKey(userId)
  const clients = useMcpClients({ poll: true })
  const balances = useWalletBalances(walletAddress)
  const [managingId, setManagingId] = useState<string>()
  const [search, setSearch] = useState('')
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokeMcpClient(getAccessToken, grantId),
    onSuccess: () => setManagingId(undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const limit = useMutation({
    mutationFn: ({
      grantId,
      limitUsd,
    }: {
      grantId: string
      limitUsd: string
    }) => setMcpClientLimit(getAccessToken, grantId, limitUsd),
    onSuccess: () => setManagingId(undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const managing = clients.data?.find((c) => c.grantId === managingId)

  // Opens or closes the client drawer, leaving behind any failure from the
  // client that was open before.
  function manage(grantId: string | undefined) {
    revoke.reset()
    limit.reset()
    setManagingId(grantId)
  }

  return (
    <section className="mt-9" aria-label="Connected clients">
      <SectionHead title="Connected clients">
        {clients.data && (
          <span className="rounded-full border border-line bg-panel-2 px-2 font-mono text-[11px] font-medium text-fg-2">
            {clients.data.length}
          </span>
        )}
        {clients.data && clients.data.length > 0 && (
          <div className="flex w-full flex-wrap items-center gap-2.5 md:ml-auto md:w-auto">
            <ClientTotals clients={clients.data} />
            <input
              type="search"
              className="d-input w-auto flex-1 md:w-[190px] md:flex-none"
              placeholder="Find a client…"
              aria-label="Find a client"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        )}
      </SectionHead>
      {clients.isPending ? (
        <span className="d-card block h-[110px] animate-pulse" />
      ) : clients.isError ? (
        <p role="alert" className="text-[13px] text-bad">
          Could not load connected clients.
        </p>
      ) : (
        <ClientTable
          clients={clients.data}
          search={search}
          onManage={(client) => manage(client.grantId)}
        />
      )}

      <Drawer
        open={managing !== undefined}
        onClose={() => manage(undefined)}
        label={managing ? `Manage ${clientName(managing)}` : 'Manage client'}
      >
        {managing && (
          <ClientDetail
            // A fresh editor for each client, starting from its saved limit.
            key={managing.grantId}
            client={managing}
            balanceMicroUsd={
              balances.data ? Number(balances.data.usdc) : undefined
            }
            revoking={revoke.isPending}
            revokeFailed={revoke.isError}
            onSetLimit={(limitUsd) =>
              limit.mutateAsync({ grantId: managing.grantId, limitUsd })
            }
            onRevoke={() => revoke.mutate(managing.grantId)}
            onViewActivity={() => onViewActivity(managing.clientId)}
            onClose={() => manage(undefined)}
          />
        )}
      </Drawer>
    </section>
  )
}

export function ClientTotals({ clients }: { clients: McpClient[] }) {
  const spent = clients.reduce((sum, c) => sum + c.spentMicroUsd, 0)
  return (
    <p className="text-[13px] text-fg-2">
      {clients.length} connected,{' '}
      <b className="font-mono font-semibold text-fg">{formatUsd(spent)}</b>{' '}
      spent in total
    </p>
  )
}

export function ClientTable({
  clients,
  search = '',
  onManage,
  now = Date.now(),
}: {
  clients: McpClient[]
  /** Shows only clients whose name or host contains this. */
  search?: string
  onManage: (client: McpClient) => void
  now?: number
}) {
  const [sort, setSort] = useState<SortKey>('last')
  const [showAll, setShowAll] = useState(false)

  if (clients.length === 0)
    return (
      <p className="d-empty">
        No clients connected yet. Connect Claude, ChatGPT, Codex, Cursor, or any
        MCP client, and it appears here with its spending limit.
      </p>
    )

  const term = search.trim().toLowerCase()
  const list = clients
    .filter((client) =>
      `${clientName(client)} ${client.redirectHost ?? client.clientId}`
        .toLowerCase()
        .includes(term),
    )
    .sort(SORTS[sort])
  const shown = showAll || term ? list : list.slice(0, SHOWN)

  function head(key: SortKey, label: string, className = '') {
    return (
      <button
        type="button"
        onClick={() => setSort(key)}
        // One of the sort buttons is pressed: the order the rows are in.
        aria-label={`Sort by ${label.toLowerCase()}`}
        aria-pressed={sort === key}
        className={`d-label cursor-pointer hover:text-fg aria-pressed:text-fg ${className}`}
      >
        {label}
        {sort === key && <span aria-hidden="true"> ↓</span>}
      </button>
    )
  }

  return (
    <div className="d-card">
      <div
        role="group"
        aria-label="Sort clients"
        className={`${ROW} d-th hidden min-h-9 md:grid`}
      >
        {head('name', 'Client', 'text-left')}
        <span className="d-label">Spend / limit</span>
        {head('left', 'Remaining', 'text-left')}
        {head('last', 'Activity', 'text-left')}
        <span />
      </div>
      {shown.length === 0 ? (
        <p className="border-t border-line px-4 py-[26px] text-center text-fg-3">
          No client matches “{search.trim()}”.
        </p>
      ) : (
        <ul>
          {shown.map((client) => (
            <li key={client.grantId} className="border-t border-line">
              <ClientRow
                client={client}
                now={now}
                onManage={() => onManage(client)}
              />
            </li>
          ))}
        </ul>
      )}
      {!term && list.length > SHOWN && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          className="d-hatch block w-full cursor-pointer border-t border-line p-[11px] text-center font-mono text-[12.5px] font-medium text-fg-2 hover:text-fg"
        >
          {showAll
            ? 'Show fewer'
            : `Show ${list.length - SHOWN} more ${list.length - SHOWN === 1 ? 'client' : 'clients'}`}
        </button>
      )}
    </div>
  )
}

function ClientRow({
  client,
  now,
  onManage,
}: {
  client: McpClient
  now: number
  onManage: () => void
}) {
  const state = stateOf(client, now)
  return (
    <button
      type="button"
      onClick={onManage}
      className={`${ROW} w-full cursor-pointer py-3 text-left hover:bg-surface md:min-h-[54px] md:py-2.5`}
    >
      <span className="min-w-0">
        <b className="block truncate font-semibold" title={clientName(client)}>
          {clientName(client)}
        </b>
      </span>
      {canPay(client) ? (
        <>
          <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-auto">
            <UsageBar client={client} state={state} />
            <span className="mt-1 block font-mono text-[11.5px] text-fg-3">
              {formatUsd(client.spentMicroUsd)} /{' '}
              {formatUsd(client.limitMicroUsd)}
            </span>
          </span>
          <span
            className={`col-start-2 row-start-1 text-right font-mono text-[14px] font-semibold whitespace-nowrap md:col-auto md:row-auto md:text-left ${state === 'full' ? 'text-bad' : ''}`}
          >
            {formatUsd(leftOf(client))}
            <span className="text-[12px] font-normal text-fg-3 md:hidden">
              {' '}
              remaining
            </span>
          </span>
        </>
      ) : (
        <>
          <span className="hidden font-mono text-[11.5px] text-fg-3 md:block">
            No spending limit
          </span>
          <span className="col-start-2 row-start-1 text-right font-mono text-fg-3 md:col-auto md:row-auto md:text-left">
            —
          </span>
        </>
      )}
      <span className="col-span-2 row-start-3 flex flex-wrap items-center gap-x-2 gap-y-1 md:col-span-1 md:row-auto md:flex-col md:items-start">
        <span className="d-status" data-state={state}>
          <i />
          {STATE_LABELS[state]}
        </span>
        <span className="text-[11.5px] text-fg-3">
          {client.lastUsedAt !== null
            ? `Last used ${timeAgo(client.lastUsedAt, now)}`
            : 'Not used yet'}
        </span>
      </span>
      <span className="hidden md:block">
        <span className="d-btn d-btn-sm">Manage</span>
      </span>
    </button>
  )
}

function UsageBar({
  client,
  state,
}: {
  client: McpClient
  state: ClientState
}) {
  const share = client.limitMicroUsd
    ? Math.max(0, Math.min(1, client.spentMicroUsd / client.limitMicroUsd))
    : 1
  return (
    <span aria-hidden="true" className="d-usage-bar" data-state={state}>
      <i style={{ width: `${share * 100}%` }} />
    </span>
  )
}

export function ClientDetail({
  client,
  balanceMicroUsd,
  revoking,
  revokeFailed,
  onSetLimit,
  onRevoke,
  onViewActivity,
  onClose,
  now = Date.now(),
}: {
  client: McpClient
  balanceMicroUsd: number | undefined
  revoking: boolean
  revokeFailed: boolean
  onSetLimit: (limitUsd: string) => Promise<void>
  onRevoke: () => void
  onViewActivity: () => void
  onClose: () => void
  now?: number
}) {
  const [confirming, setConfirming] = useState(false)
  const name = clientName(client)
  const facts: Array<[string, ReactNode]> = [
    ['Tools', toolsOf(client)],
    ['Estimated credits', client.estimatedCredits.toLocaleString('en-US')],
    ['Connected', timeAgo(client.connectedAt, now)],
    [
      'Last used',
      client.lastUsedAt ? timeAgo(client.lastUsedAt, now) : 'Not used yet',
    ],
  ]
  if (canPay(client)) facts.unshift(['Spent', formatUsd(client.spentMicroUsd)])

  return (
    <>
      <DrawerHeader
        title={name}
        detail={client.redirectHost ?? client.clientId}
        onClose={onClose}
      />
      {canPay(client) && (
        <LimitEditor
          client={client}
          balanceMicroUsd={balanceMicroUsd}
          onSave={onSetLimit}
        />
      )}
      <DrawerFacts facts={facts} />
      <p className="mt-3 text-[12px] text-fg-3">{CREDIT_ESTIMATE_NOTE}</p>
      {/* The page behind an open drawer cannot be reached, so a failure is
          reported here, where the action was taken. */}
      <p role="alert" className="mt-5 text-[13px] text-bad empty:hidden">
        {revokeFailed ? 'Could not disconnect the client. Try again.' : ''}
      </p>
      {confirming ? (
        <div className="mt-6 rounded-[10px] border border-line bg-surface px-3.5 py-3">
          <p className="text-[13px]">
            Disconnect {name}? It loses access right away and must be approved
            again to reconnect.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="d-btn d-btn-sm d-btn-danger disabled:cursor-wait"
              disabled={revoking}
              onClick={onRevoke}
            >
              {revoking ? 'Disconnecting…' : 'Disconnect'}
            </button>
            <button
              type="button"
              className="d-btn d-btn-sm"
              disabled={revoking}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap gap-2">
          <button
            type="button"
            className="d-btn d-btn-sm"
            onClick={onViewActivity}
          >
            View its activity
          </button>
          <button
            type="button"
            className="d-btn d-btn-sm d-btn-danger-quiet"
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </button>
        </div>
      )}
    </>
  )
}
