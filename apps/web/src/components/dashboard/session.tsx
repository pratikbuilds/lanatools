import { createContext, useContext } from 'react'
import type { GetAccessToken } from '#/lib/mcp-clients'

/** Who is signed in to the dashboard, shared by every page under it. */
export type DashboardSession = {
  userId: string
  /** The embedded payment wallet, or null until the user creates one. */
  walletAddress: string | null
  getAccessToken: GetAccessToken
}

const SessionContext = createContext<DashboardSession | null>(null)

export const DashboardSessionProvider = SessionContext.Provider

export function useDashboardSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('Dashboard pages need a signed-in session')
  return session
}
