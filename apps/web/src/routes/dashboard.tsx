import { usePrivy } from '@privy-io/react-auth'
import { Navigate, Outlet, createFileRoute } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { useState } from 'react'
import { useAttachPaymentSigner } from '#/components/dashboard/agent-payments'
import { DashboardSessionProvider } from '#/components/dashboard/session'
import { DashboardShell } from '#/components/dashboard/shell'
import { BrandMark } from '#/components/landing/brand'
import { getEmbeddedPayer } from '#/lib/payer'

export const Route = createFileRoute('/dashboard')({
  component: DashboardRoute,
})

const appId = import.meta.env.VITE_PRIVY_APP_ID

function DashboardRoute() {
  // Without Privy there is no account; the sign-in page explains why.
  if (!appId) return <Navigate to="/sign-in" replace />
  return (
    <MotionConfig reducedMotion="user">
      <Dashboard />
    </MotionConfig>
  )
}

function Dashboard() {
  const { ready, authenticated, user, logout, getAccessToken } = usePrivy()
  const [signingOut, setSigningOut] = useState(false)
  const [signOutFailed, setSignOutFailed] = useState(false)

  if (!ready) return <Loading />
  // Signing out ends at home; any other signed-out visit goes to sign-in.
  if (!authenticated || !user) {
    return <Navigate to={signingOut ? '/' : '/sign-in'} replace />
  }

  async function signOut() {
    setSignOutFailed(false)
    setSigningOut(true)
    try {
      await logout()
    } catch {
      setSigningOut(false)
      setSignOutFailed(true)
    }
  }

  return (
    <DashboardSessionProvider
      value={{
        userId: user.id,
        walletAddress: getEmbeddedPayer(user)?.address ?? null,
        getAccessToken,
      }}
    >
      <PaymentSetup />
      <DashboardShell
        account={user.google?.name || user.google?.email || user.email?.address}
        onSignOut={() => void signOut()}
        signOutFailed={signOutFailed}
      >
        <Outlet />
      </DashboardShell>
    </DashboardSessionProvider>
  )
}

/** Runs the one-time payment setup for whichever dashboard page is open. */
function PaymentSetup() {
  useAttachPaymentSigner()
  return null
}

function Loading() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-blue text-paper">
      <BrandMark size={44} animate />
      <p role="status" className="text-[13px] text-paper-2">
        Opening your dashboard…
      </p>
    </div>
  )
}
