import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  MAX_CLIENT_LIMIT_MICRO_USD,
  formatUsd,
  parseClientLimit,
} from '@lanatools/contracts'
import type { McpClient } from '@lanatools/contracts'
import {
  MCP_SERVER_URL,
  listMcpClients,
  revokeMcpClient,
  setMcpClientLimit,
  timeAgo,
} from '#/lib/mcp-clients'
import type { GetAccessToken } from '#/lib/mcp-clients'

const SCOPE_LABELS: Record<string, string> = {
  'account:read': 'Can see your LanaTools account ID',
  'payments:pay': 'Can pay from your wallet within its limit',
}

export function ConnectedApps({
  userId,
  getAccessToken,
}: {
  userId: string
  getAccessToken: GetAccessToken
}) {
  const queryClient = useQueryClient()
  // Keyed by user so another account signing in never sees these rows.
  const queryKey = ['mcp-clients', userId]
  const clients = useQuery({
    queryKey,
    queryFn: () => listMcpClients(getAccessToken),
  })
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokeMcpClient(getAccessToken, grantId),
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
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })

  return (
    <section className="box box-lg mt-8 px-6 py-7 sm:px-8">
      <h2 className="text-[15px] font-bold">Connected apps</h2>
      <p className="mt-1 text-[13px] text-mute">
        AI apps you connected through the LanaTools MCP server.
      </p>
      {clients.isPending ? (
        <span className="mt-5 block h-16 animate-pulse rounded-[8px] bg-paper" />
      ) : clients.isError ? (
        <p role="alert" className="mt-5 text-[13px] text-coral-ink">
          Could not load connected apps.
        </p>
      ) : (
        <ConnectedAppList
          clients={clients.data}
          revokingId={revoke.isPending ? revoke.variables : undefined}
          onRevoke={(grantId) => revoke.mutate(grantId)}
          onSetLimit={(grantId, limitUsd) =>
            limit.mutateAsync({ grantId, limitUsd })
          }
        />
      )}
      <p role="alert" className="mt-3 text-[13px] text-coral-ink empty:hidden">
        {revoke.isError
          ? 'Could not disconnect the app. Try again.'
          : limit.isError
            ? 'Could not change the limit. Try again.'
            : ''}
      </p>
    </section>
  )
}

export function ConnectedAppList({
  clients,
  revokingId,
  onRevoke,
  onSetLimit = async () => {},
  now = Date.now(),
}: {
  clients: McpClient[]
  revokingId: string | undefined
  onRevoke: (grantId: string) => void
  onSetLimit?: (grantId: string, limitUsd: string) => Promise<void>
  now?: number
}) {
  if (clients.length === 0)
    return (
      <p className="mt-5 text-[13px] leading-5 text-mute">
        No apps connected. Add{' '}
        <code className="font-semibold break-all text-ink">
          {MCP_SERVER_URL}
        </code>{' '}
        as an MCP server in your AI app to connect it.
      </p>
    )
  return (
    <ul className="mt-5 divide-y divide-rule border-y border-rule">
      {clients.map((client) => (
        <ClientRow
          key={client.grantId}
          client={client}
          now={now}
          revoking={revokingId === client.grantId}
          onRevoke={() => onRevoke(client.grantId)}
          onSetLimit={(limitUsd) => onSetLimit(client.grantId, limitUsd)}
        />
      ))}
    </ul>
  )
}

function ClientRow({
  client,
  now,
  revoking,
  onRevoke,
  onSetLimit,
}: {
  client: McpClient
  now: number
  revoking: boolean
  onRevoke: () => void
  onSetLimit: (limitUsd: string) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const name = client.clientName ?? 'Unknown app'

  return (
    <li className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[14px] font-bold break-words">{name}</p>
          {/* Clients choose their own names; the host is what the user approved. */}
          <p className="text-[12.5px] break-all text-mute">
            {client.redirectHost ?? client.clientId}
          </p>
        </div>
        {!confirming && (
          <button
            type="button"
            className="btn btn-sm shrink-0"
            onClick={() => setConfirming(true)}
          >
            Disconnect
          </button>
        )}
      </div>
      <p className="mt-2 text-[12.5px] text-mute">
        {client.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join(', ')}
      </p>
      <p className="mt-1 text-[12.5px] text-mute">
        Connected {timeAgo(client.connectedAt, now)} ·{' '}
        {client.lastUsedAt
          ? `Last used ${timeAgo(client.lastUsedAt, now)}`
          : 'Not used yet'}
      </p>
      {client.scopes.includes('payments:pay') && (
        <Spending client={client} onSetLimit={onSetLimit} />
      )}
      {confirming && (
        <div className="mt-3 rounded-[8px] border-[1.5px] border-ink bg-paper px-3.5 py-3">
          <p className="text-[13px]">
            Disconnect {name}? It loses access right away and must be approved
            again to reconnect.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary disabled:cursor-wait"
              disabled={revoking}
              onClick={onRevoke}
            >
              {revoking ? 'Disconnecting…' : 'Disconnect'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={revoking}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

function Spending({
  client,
  onSetLimit,
}: {
  client: McpClient
  onSetLimit: (limitUsd: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const remaining = Math.max(
    0,
    client.limitMicroUsd - client.spentMicroUsd - client.reservedMicroUsd,
  )
  const valid = parseClientLimit(draft) !== null

  async function save() {
    if (!valid) return
    setSaving(true)
    try {
      await onSetLimit(draft)
      setEditing(false)
    } catch {
      // The list shows the error; keep the draft so it can be retried.
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-3 rounded-[8px] border border-rule bg-paper px-3.5 py-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12.5px] sm:grid-cols-4">
        {(
          [
            ['Limit', client.limitMicroUsd],
            ['Spent', client.spentMicroUsd],
            ['Reserved', client.reservedMicroUsd],
            ['Remaining', remaining],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="text-mute">{label}</dt>
            <dd className="font-bold tabular-nums">{formatUsd(value)}</dd>
          </div>
        ))}
      </dl>
      {client.reservedMicroUsd > 0 && (
        <p className="mt-2 text-[12px] text-mute">
          Reserved money belongs to payments whose outcome is not confirmed yet.
          It stays counted until they are resolved.
        </p>
      )}
      {editing ? (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="flex items-center gap-1.5 text-[13px] font-semibold">
            $
            <input
              className="w-24 rounded-[6px] border-[1.5px] border-ink bg-white px-2 py-1 text-[13px]"
              inputMode="decimal"
              aria-label="New spending limit in USD"
              aria-invalid={!valid}
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <button
            type="submit"
            className="btn btn-sm btn-primary disabled:cursor-wait"
            disabled={!valid || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={saving}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
          {!valid && (
            <p className="w-full text-[12px] text-coral-ink">
              Enter an amount up to {formatUsd(MAX_CLIENT_LIMIT_MICRO_USD)}.
            </p>
          )}
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-sm mt-3"
          onClick={() => {
            setDraft(
              formatUsd(client.limitMicroUsd).slice(1).replaceAll(',', ''),
            )
            setEditing(true)
          }}
        >
          Change limit
        </button>
      )}
    </div>
  )
}
