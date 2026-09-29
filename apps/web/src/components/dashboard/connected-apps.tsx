import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { McpClient } from '@lanatools/contracts'
import {
  MCP_SERVER_URL,
  listMcpClients,
  revokeMcpClient,
  timeAgo,
} from '#/lib/mcp-clients'
import type { GetAccessToken } from '#/lib/mcp-clients'

const SCOPE_LABELS: Record<string, string> = {
  'account:read': 'Can see your LanaTools account ID',
}

export function ConnectedApps({
  getAccessToken,
}: {
  getAccessToken: GetAccessToken
}) {
  const queryClient = useQueryClient()
  const clients = useQuery({
    queryKey: ['mcp-clients'],
    queryFn: () => listMcpClients(getAccessToken),
  })
  const revoke = useMutation({
    mutationFn: (grantId: string) => revokeMcpClient(getAccessToken, grantId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['mcp-clients'] }),
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
        />
      )}
      <p role="alert" className="mt-3 text-[13px] text-coral-ink empty:hidden">
        {revoke.isError ? 'Could not disconnect the app. Try again.' : ''}
      </p>
    </section>
  )
}

export function ConnectedAppList({
  clients,
  revokingId,
  onRevoke,
  now = Date.now(),
}: {
  clients: McpClient[]
  revokingId: string | undefined
  onRevoke: (grantId: string) => void
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
}: {
  client: McpClient
  now: number
  revoking: boolean
  onRevoke: () => void
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
