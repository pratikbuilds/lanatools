import { usePrivy } from '@privy-io/react-auth'
import { Navigate, Outlet, createFileRoute } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { lazy, Suspense, useState } from 'react'
import { AccountLoading } from '#/components/dashboard/account-loading'
import { DashboardSessionProvider } from '#/components/dashboard/session'
import { DashboardShell } from '#/components/dashboard/shell'
import { NetworkStatus } from '#/components/dashboard/network-status'
import { getAccountName, getEmbeddedPayer } from '#/lib/payer'

export const Route = createFileRoute('/_account/dashboard')({
  component: DashboardRoute,
})

const appId = import.meta.env.VITE_PRIVY_APP_ID

const PaymentSetup = lazy(() =>
  import('#/components/dashboard/payment-setup').then((module) => ({
    default: module.PaymentSetup,
  })),
)
const PaymentStatus = lazy(() =>
  import('#/components/dashboard/status-bar').then((module) => ({
    default: module.PaymentStatus,
  })),
)

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

  if (!ready) return <AccountLoading />
  // Signing out ends at home; any other signed-out visit goes to sign-in.
  // The loading frame stays up while that page loads, instead of a blank one.
  if (!authenticated) {
    return (
      <>
        <Navigate to={signingOut ? '/' : '/sign-in'} replace />
        <AccountLoading />
      </>
    )
  }
  // A restored session can be authenticated before `user` arrives. That is
  // still signed in, so it must not be sent back to sign-in.
  if (!user) return <AccountLoading />

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
      <Suspense fallback={null}>
        <PaymentSetup />
      </Suspense>
      <DashboardShell
        session={{
          account: getAccountName(user),
          onSignOut: () => void signOut(),
          signOutFailed,
        }}
        status={{
          start: (
            <Suspense
              fallback={
                <span className="d-status" data-state="idle">
                  <i aria-hidden="true" />
                  Agent payments…
                </span>
              }
            >
              <PaymentStatus />
            </Suspense>
          ),
          end: <NetworkStatus />,
        }}
      >
        <Outlet />
      </DashboardShell>
    </DashboardSessionProvider>
  )
}
