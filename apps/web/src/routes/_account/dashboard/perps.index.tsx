import { Navigate, createFileRoute } from '@tanstack/react-router'
import { PageHead } from '#/components/dashboard/page-head'
import { useDashboardSession } from '#/components/dashboard/session'

export const Route = createFileRoute('/_account/dashboard/perps/')({
  component: OwnPerps,
})

/** The user's own Phoenix account: their LanaTools wallet's. */
function OwnPerps() {
  const { walletAddress } = useDashboardSession()
  if (walletAddress)
    return (
      <Navigate
        to="/dashboard/perps/$address"
        params={{ address: walletAddress }}
        replace
      />
    )
  return (
    <>
      <PageHead title="Phoenix account" />
      <p className="d-empty mt-6 text-[13px]">
        Your LanaTools wallet is still being set up. Its Phoenix account shows
        here once it is ready.
      </p>
    </>
  )
}
