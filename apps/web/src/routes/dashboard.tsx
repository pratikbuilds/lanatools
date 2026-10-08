import { usePrivy } from '@privy-io/react-auth'
import { Navigate, Outlet, createFileRoute } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { useState } from 'react'
import { useAttachPaymentSigner } from '#/components/dashboard/agent-payments'
import { DashboardSessionProvider } from '#/components/dashboard/session'
import { DashboardShell } from '#/components/dashboard/shell'
import { SplitPanel } from '#/components/dashboard/split-panel'
import { NetworkStatus, PaymentStatus } from '#/components/dashboard/status-bar'
import { getAccountName, getEmbeddedPayer } from '#/lib/payer'

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
  // The loading frame stays up while that page loads, instead of a blank one.
  if (!authenticated || !user) {
    return (
      <>
        <Navigate to={signingOut ? '/' : '/sign-in'} replace />
        <Loading />
      </>
    )
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
        session={{
          account: getAccountName(user),
          onSignOut: () => void signOut(),
          signOutFailed,
        }}
        status={{ start: <PaymentStatus />, end: <NetworkStatus /> }}
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

/**
 * The dashboard's own layout in grey while the account loads, so the page
 * fills in where it stands instead of jumping into place.
 */
function Loading() {
  return (
    <DashboardShell
      status={{
        start: (
          <span className="d-status" data-state="idle">
            <i aria-hidden="true" />
            Checking your account…
          </span>
        ),
        end: <NetworkStatus />,
      }}
    >
      <p role="status" className="sr-only">
        Opening your dashboard…
      </p>
      <div aria-hidden="true">
        <div className="flex items-center gap-2.5">
          <Bone className="h-6 w-24" />
          <Bone className="h-[26px] w-36" />
          <Bone className="ml-auto h-[34px] w-40 max-sm:hidden" />
        </div>
        <SplitPanel
          className="mt-5"
          left={
            <>
              <Bone className="h-3 w-20" />
              <Bone className="mt-4 mb-3 h-[44px] w-56 sm:h-[58px]" />
              <Bone className="h-3.5 w-full max-w-[330px]" />
              <Bone className="mt-2 h-3.5 w-48" />
            </>
          }
          right={
            <>
              <Bone className="h-3 w-24" />
              <Bone className="mt-3 mb-4 h-[58px] w-full" />
              <Bone className="h-[34px] w-28" />
            </>
          }
        />
        <Bone className="mt-9 mb-3 h-4 w-40" />
        <div className="d-card">
          <div className="d-th h-9" />
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="flex min-h-[54px] items-center gap-4 border-t border-line px-4"
            >
              <span className="flex-[1.5]">
                <Bone className="h-3.5 w-32" />
                <Bone className="mt-1.5 h-2.5 w-24" />
              </span>
              <Bone className="h-3 w-20 max-md:hidden" />
              <Bone className="h-3 flex-[1.7] max-md:hidden" />
              <Bone className="h-3.5 w-14" />
            </div>
          ))}
        </div>
      </div>
    </DashboardShell>
  )
}

function Bone({ className }: { className: string }) {
  return (
    <span
      className={`block animate-pulse rounded-[6px] bg-panel-2 motion-reduce:animate-none ${className}`}
    />
  )
}
