import { useLocation } from '@tanstack/react-router'
import {
  ActivityTotals,
  HeatmapSkeleton,
} from '#/components/dashboard/activity-summary'
import { CallSkeleton } from '#/components/dashboard/call-table'
import { ClientSkeleton } from '#/components/dashboard/client-skeleton'
import { DashboardShell } from '#/components/dashboard/shell'
import { NetworkStatus } from '#/components/dashboard/network-status'
import { PageHead, SectionHead } from '#/components/dashboard/page-head'
import { Skeleton } from '#/components/dashboard/skeleton'
import { WalletPageHead } from '#/components/dashboard/wallet-page-head'
import { WalletPanelView } from '#/components/dashboard/wallet-panel-view'
import { CREDIT_ESTIMATE_NOTE } from '#/lib/activity'

/** Keeps the current page's layout visible while the account loads. */
export function AccountLoading() {
  const { pathname } = useLocation()
  const page = pathname.startsWith('/dashboard/activity')
    ? 'Activity'
    : pathname.startsWith('/dashboard/payments')
      ? 'Payments'
      : pathname.startsWith('/dashboard/settings')
        ? 'Settings'
        : pathname.startsWith('/dashboard/transactions')
          ? 'Transactions'
          : pathname.startsWith('/dashboard/perps')
            ? 'Perps'
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
        ) : page === 'Payments' ? (
          <>
            <PageHead title="Payments" />
            <Skeleton className="mt-5 h-[160px] w-full" />
          </>
        ) : page === 'Transactions' ? (
          <>
            <PageHead title="Transactions" />
            <Skeleton className="mt-5 h-10 w-full" />
            <Skeleton className="d-card mt-4 h-[140px]" />
          </>
        ) : page === 'Perps' ? (
          <>
            <PageHead title="Phoenix account" />
            <Skeleton className="mt-6 h-[52px] w-full max-w-[34rem]" />
            <Skeleton className="d-card mt-5 h-[420px] w-full" />
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
              <Skeleton className="h-[160px] w-full" />
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
