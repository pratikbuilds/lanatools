import { useQuery } from '@tanstack/react-query'
import { listMcpClients } from '#/lib/mcp-clients'
import { useDashboardSession } from './session'

/** Keyed by user so another account signing in never sees these rows. */
export function mcpClientsKey(userId: string) {
  return ['mcp-clients', userId]
}

/**
 * The signed-in user's connected clients. Only the page that lists them
 * polls; anything else reads whatever that page last fetched.
 */
export function useMcpClients({ poll = false }: { poll?: boolean } = {}) {
  const { userId, getAccessToken } = useDashboardSession()
  return useQuery({
    queryKey: mcpClientsKey(userId),
    queryFn: () => listMcpClients(getAccessToken),
    refetchInterval: poll ? 15_000 : false,
  })
}
