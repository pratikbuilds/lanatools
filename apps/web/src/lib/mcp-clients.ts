import { McpClientList } from '@lanatools/contracts'
import type { McpClient } from '@lanatools/contracts'

export type GetAccessToken = () => Promise<string | null>

export async function authorized(getAccessToken: GetAccessToken) {
  const token = await getAccessToken()
  if (!token) throw new Error('Sign in again to manage connected apps.')
  return { Authorization: `Bearer ${token}` }
}

export async function listMcpClients(
  getAccessToken: GetAccessToken,
): Promise<McpClient[]> {
  const response = await fetch('/api/mcp/clients', {
    headers: await authorized(getAccessToken),
  })
  if (!response.ok) throw new Error('Could not load connected apps.')
  return McpClientList.assert(await response.json()).clients
}

export async function revokeMcpClient(
  getAccessToken: GetAccessToken,
  grantId: string,
) {
  const response = await fetch(
    `/api/mcp/clients/${encodeURIComponent(grantId)}/revoke`,
    { method: 'POST', headers: await authorized(getAccessToken) },
  )
  // 404: already revoked, possibly from another tab. The list refresh shows it.
  if (!response.ok && response.status !== 404)
    throw new Error('Could not disconnect the app.')
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
] as const

export function timeAgo(timestamp: number, now = Date.now()) {
  const elapsed = now - timestamp
  for (const [unit, ms] of UNITS)
    if (elapsed >= ms) return relative.format(-Math.floor(elapsed / ms), unit)
  return 'just now'
}

export async function setMcpClientLimit(
  getAccessToken: GetAccessToken,
  grantId: string,
  limitUsd: string,
) {
  const response = await fetch(
    `/api/mcp/clients/${encodeURIComponent(grantId)}/limit`,
    {
      method: 'PUT',
      headers: {
        ...(await authorized(getAccessToken)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limitUsd }),
    },
  )
  if (!response.ok) throw new Error('Could not change the limit.')
}

export async function setMcpClientOutgoing(
  getAccessToken: GetAccessToken,
  grantId: string,
  allowed: boolean,
) {
  const response = await fetch(
    `/api/mcp/clients/${encodeURIComponent(grantId)}/outgoing`,
    {
      method: 'PUT',
      headers: {
        ...(await authorized(getAccessToken)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ allowed }),
    },
  )
  if (!response.ok) throw new Error('Could not change the outgoing permission.')
}
