import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { formatUsd } from '@lanatools/contracts'
import type { McpClient } from '@lanatools/contracts'
import {
  listMcpClients,
  revokeMcpClient,
  setMcpClientLimit,
  timeAgo,
} from '#/lib/mcp-clients'
import { ConnectClient } from './connect-client'
import { Drawer, DrawerFacts, DrawerHeader } from './drawer'
import { LimitEditor } from './limit-editor'
import { useDashboardSession } from './session'
import { useWalletBalances } from './wallet-panel'

const SCOPE_LABELS: Record<string, string> = {
  'account:read': 'See your LanaTools account ID',
  'payments:pay': 'Pay from your wallet within its limit',
  'jupiter:read': 'Read Jupiter token information and prices',
}

const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 md:grid-cols-[minmax(9rem,1.1fr)_minmax(12rem,2.2fr)_6.5rem_7rem_5.5rem] md:gap-6 md:px-[22px]'

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

export function ConnectedClients({
  onViewActivity,
}: {
  onViewActivity: (clientId: string) => void
}) {
  const { userId, walletAddress, getAccessToken } = useDashboardSession()
  const queryClient = useQueryClient()
  // Keyed by user so another account signing in never sees these rows.
  const queryKey = ['mcp-clients', userId]
  const clients = useQuery({
    queryKey,
    queryFn: () => listMcpClients(getAccessToken),
    refetchInterval: 15_000,
  })
  const balances = useWalletBalances(walletAddress)
  const [managingId, setManagingId] = useState<string>()
  const [connecting, setConnecting] = useState(false)
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
    <section className="mt-10">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <h2 className="text-[15px] font-bold">Connected clients</h2>
        <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2.5">
          {clients.data && clients.data.length > 0 && (
            <ClientTotals clients={clients.data} />
          )}
          <button
            type="button"
            className="btn btn-flat"
            onClick={() => setConnecting(true)}
          >
            Connect a client
          </button>
        </div>
      </div>
      {clients.isPending ? (
        <span className="block h-[110px] animate-pulse rounded-[10px] bg-card" />
      ) : clients.isError ? (
        <p role="alert" className="text-[13px] text-coral-ink">
          Could not load connected clients.
        </p>
      ) : (
        <ClientTable
          clients={clients.data}
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

      <Drawer
        open={connecting}
        onClose={() => setConnecting(false)}
        label="Connect a client"
      >
        <DrawerHeader
          title="Connect a client"
          detail="One URL for every AI client"
          onClose={() => setConnecting(false)}
        />
        <ConnectClient />
      </Drawer>
    </section>
  )
}

export function ClientTotals({ clients }: { clients: McpClient[] }) {
  const spent = clients.reduce((sum, c) => sum + c.spentMicroUsd, 0)
  return (
    <p className="text-[12px] text-mute">
      {clients.length} connected,{' '}
      <b className="text-[15px] text-ink">{formatUsd(spent)}</b> spent in total
    </p>
  )
}

export function ClientTable({
  clients,
  onManage,
  now = Date.now(),
}: {
  clients: McpClient[]
  onManage: (client: McpClient) => void
  now?: number
}) {
  if (clients.length === 0)
    return (
      <p className="rounded-[10px] border-[1.5px] border-dashed border-mute px-[22px] py-6 text-[13px] leading-5 text-mute">
        No clients connected yet. Connect Claude, ChatGPT, Codex, Cursor, or any
        MCP client, and it appears here with its spending limit.
      </p>
    )
  return (
    <div className="overflow-hidden rounded-[10px] border-[1.5px] border-ink bg-card">
      <div
        aria-hidden="true"
        className={`${ROW} hidden h-[38px] border-b-[1.5px] border-ink bg-paper text-[12px] text-mute md:grid`}
      >
        <span>Client</span>
        <span>Spent of limit</span>
        <span className="text-right">Left</span>
        <span className="text-right">Last used</span>
        <span />
      </div>
      <ul>
        {clients.map((client) => (
          <li
            key={client.grantId}
            className="border-b border-rule last:border-b-0"
          >
            <button
              type="button"
              onClick={() => onManage(client)}
              className={`${ROW} w-full py-3.5 text-left hover:bg-white md:min-h-[72px] md:py-0`}
            >
              <span className="min-w-0">
                <b className="block truncate text-[14.5px]">
                  {clientName(client)}
                </b>
                {/* Clients choose their own names; the host is what the user approved. */}
                <span className="block truncate text-[12px] text-mute">
                  {client.redirectHost ?? client.clientId}
                </span>
              </span>
              {canPay(client) ? (
                <>
                  <span className="order-last col-span-2 flex items-center gap-3.5 md:order-none md:col-span-1">
                    <UsageBar client={client} />
                    <span className="text-[12.5px] whitespace-nowrap text-mute">
                      <b className="text-ink">
                        {formatUsd(client.spentMicroUsd)}
                      </b>{' '}
                      / {formatUsd(client.limitMicroUsd)}
                    </span>
                  </span>
                  <span
                    className={`text-right text-[16px] font-bold tracking-tight whitespace-nowrap ${leftOf(client) === 0 ? 'text-coral-ink' : ''}`}
                  >
                    {formatUsd(leftOf(client))}
                    <span className="text-[12px] font-normal tracking-normal text-mute md:hidden">
                      {' '}
                      left
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <span className="hidden text-[12.5px] text-mute md:block">
                    Cannot pay
                  </span>
                  <span className="text-right text-mute">—</span>
                </>
              )}
              <span className="hidden text-right text-[12px] whitespace-nowrap text-mute md:block">
                {client.lastUsedAt
                  ? timeAgo(client.lastUsedAt, now)
                  : 'Not used yet'}
              </span>
              <span className="hidden text-right md:block">
                <span className="btn btn-flat h-7 px-2.5 text-[12px]">
                  Manage
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function UsageBar({ client }: { client: McpClient }) {
  const share = client.limitMicroUsd
    ? Math.min(1, client.spentMicroUsd / client.limitMicroUsd)
    : 1
  return (
    <span className="block h-2.5 flex-1 overflow-hidden rounded-full border-[1.5px] border-ink bg-card">
      <span
        className={`block h-full ${leftOf(client) === 0 ? 'bg-coral' : 'bg-blue'}`}
        style={{ width: `${share * 100}%` }}
      />
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
    [
      'Can',
      client.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(', '),
    ],
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
      {/* The page behind an open drawer cannot be reached, so a failure is
          reported here, where the action was taken. */}
      <p role="alert" className="mt-5 text-[13px] text-coral-ink empty:hidden">
        {revokeFailed ? 'Could not disconnect the client. Try again.' : ''}
      </p>
      {confirming ? (
        <div className="mt-6 rounded-[8px] border-[1.5px] border-ink bg-paper px-3.5 py-3">
          <p className="text-[13px]">
            Disconnect {name}? It loses access right away and must be approved
            again to reconnect.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn btn-flat btn-primary disabled:cursor-wait"
              disabled={revoking}
              onClick={onRevoke}
            >
              {revoking ? 'Disconnecting…' : 'Disconnect'}
            </button>
            <button
              type="button"
              className="btn btn-flat"
              disabled={revoking}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-[12.5px] font-semibold">
          <button
            type="button"
            className="underline underline-offset-[3px]"
            onClick={onViewActivity}
          >
            View its activity
          </button>
          <button
            type="button"
            className="text-coral-ink underline underline-offset-[3px]"
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </button>
        </div>
      )}
    </>
  )
}
