import { Link, createFileRoute } from '@tanstack/react-router'
import { useMemo } from 'react'
import { PerpsPage } from '#/components/dashboard/perps'
import { useDashboardSession } from '#/components/dashboard/session'
import { signedInPhoenixReader } from '#/lib/phoenix'
import { EMPTY_FILTER } from '#/lib/transactions'

export const Route = createFileRoute('/_account/dashboard/perps/$address')({
  component: PerpsRoute,
})

function PerpsRoute() {
  const { address } = Route.useParams()
  const navigate = Route.useNavigate()
  const { userId, walletAddress, getAccessToken } = useDashboardSession()
  const reader = useMemo(
    () => signedInPhoenixReader(userId, getAccessToken),
    [userId, getAccessToken],
  )
  return (
    <PerpsPage
      // A new address is a new account; state from the last one is dropped.
      key={address}
      address={address}
      reader={reader}
      own={address === walletAddress}
      back={
        <Link
          to="/dashboard/transactions"
          search={EMPTY_FILTER}
          className="mb-3 inline-flex font-mono text-[12px] text-fg-3 hover:text-fg"
        >
          ← Transactions
        </Link>
      }
      onAddress={(next) =>
        void navigate({
          to: '/dashboard/perps/$address',
          params: { address: next },
        })
      }
    />
  )
}
