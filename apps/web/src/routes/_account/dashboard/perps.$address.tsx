import { createFileRoute } from '@tanstack/react-router'
import { PerpsPage } from '#/components/dashboard/perps'

export const Route = createFileRoute('/_account/dashboard/perps/$address')({
  component: PerpsRoute,
})

function PerpsRoute() {
  const { address } = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    <PerpsPage
      // A new address is a new account; state from the last one is dropped.
      key={address}
      address={address}
      onAddress={(next) =>
        void navigate({
          to: '/dashboard/perps/$address',
          params: { address: next },
        })
      }
    />
  )
}
