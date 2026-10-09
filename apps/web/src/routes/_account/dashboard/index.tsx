import { createFileRoute } from '@tanstack/react-router'
import { WalletPage } from '#/components/dashboard/wallet-page'

export const Route = createFileRoute('/_account/dashboard/')({
  component: WalletRoute,
})

function WalletRoute() {
  const navigate = Route.useNavigate()
  return (
    <WalletPage
      onViewActivity={(client) =>
        void navigate({
          to: '/dashboard/activity',
          search: { client, outcome: undefined },
        })
      }
    />
  )
}
