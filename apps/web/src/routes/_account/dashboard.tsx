import { usePrivy } from '@privy-io/react-auth'
import {
  Navigate,
  Outlet,
  createFileRoute,
  useLocation,
} from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
import { useState } from 'react'
import {
  AgentPaymentsView,
  useAttachPaymentSigner,
} from '#/components/dashboard/agent-payments'
import { DashboardSessionProvider } from '#/components/dashboard/session'
import { DashboardShell } from '#/components/dashboard/shell'
import {
  ActivityTotals,
  CallSkeleton,
  HeatmapSkeleton,
} from '#/components/dashboard/activity'
import { ClientSkeleton } from '#/components/dashboard/connected-clients'
import { PageHead, SectionHead } from '#/components/dashboard/page-head'
import { Skeleton } from '#/components/dashboard/skeleton'
import { WalletPageHead } from '#/components/dashboard/wallet-page'
import { WalletPanelView } from '#/components/dashboard/wallet-panel'
import { NetworkStatus, PaymentStatus } from '#/components/dashboard/status-bar'
import { CREDIT_ESTIMATE_NOTE } from '#/lib/activity'
import { getAccountName, getEmbeddedPayer } from '#/lib/payer'

export const Route = createFileRoute('/_account/dashboard')({
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

/** Keeps the current page's layout visible while the account loads. */
function Loading() {
  const { pathname } = useLocation()
  const page = pathname.startsWith('/dashboard/activity')
    ? 'Activity'
    : pathname.startsWith('/dashboard/settings')
      ? 'Settings'
      : pathname.startsWith('/dashboard/transactions')
        ? 'Transactions'
        : 'Wallet'
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
      <div aria-busy="true">
        {page === 'Wallet' ? (
          <>
            <WalletPageHead />
            <WalletPanelView
              walletAddress={null}
              balances={undefined}
              pending
              failed={false}
              onDeposit={() => {}}
              onWithdraw={() => {}}
            />
            <section className="mt-9" aria-label="Connected clients">
              <SectionHead title="Connected clients" />
              <ClientSkeleton />
            </section>
            <section className="mt-9" aria-label="Latest activity">
              <SectionHead title="Latest activity" />
              <CallSkeleton />
            </section>
          </>
        ) : page === 'Transactions' ? (
          <>
            <PageHead title="Transactions" />
            <Skeleton className="mt-5 h-10 w-full" />
            <Skeleton className="d-card mt-4 h-[140px]" />
          </>
        ) : page === 'Activity' ? (
          <>
            <PageHead title="Activity" />
            <div className="d-frame mt-5">
              <div className="d-inset d-pane flex flex-wrap items-end justify-between gap-x-14 gap-y-6">
                <ActivityTotals totals={undefined} pending />
                <HeatmapSkeleton />
              </div>
            </div>
            <p className="mt-3 text-[12.5px] text-fg-3">
              {CREDIT_ESTIMATE_NOTE}
            </p>
            <SectionHead title="Calls" className="mt-9">
              <Skeleton className="h-[34px] w-full lg:ml-auto lg:w-[520px]" />
            </SectionHead>
            <CallSkeleton />
          </>
        ) : (
          <>
            <PageHead title="Settings" />
            <section className="mt-7" aria-label="Permissions">
              <h2 className="d-h2">Permissions</h2>
              <p className="mt-1 mb-3 text-[13px] text-fg-2">
                What LanaTools may sign with your wallet.
              </p>
              <AgentPaymentsView
                status={undefined}
                loadFailed={false}
                running={undefined}
                failed={undefined}
                walletAddress=""
                onSetUp={() => {}}
                onRemove={() => {}}
              />
            </section>
            <section className="mt-9" aria-label="Wallet">
              <h2 className="d-h2">Wallet</h2>
              <p className="mt-1 mb-3 text-[13px] text-fg-2">
                The payment wallet your agents pay from.
              </p>
              <div className="d-frame">
                <div className="d-inset d-pane">
                  <p className="d-label">Private key</p>
                  <Skeleton className="mt-3 h-4 w-full max-w-[34rem]" />
                  <Skeleton className="mt-2 h-4 w-64 max-w-full" />
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </DashboardShell>
  )
}
