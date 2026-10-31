import { createFileRoute } from '@tanstack/react-router'
import { isAddress } from '@solana/kit'
import { Frame } from '#/components/dashboard/frame'
import { PerpsPage } from '#/components/dashboard/perps'
import { publicPhoenixReader } from '#/lib/phoenix'

export const Route = createFileRoute('/perps/$address')({
  component: PublicPerpsRoute,
})

/** Any wallet's Phoenix account, for agents to share; no login needed. */
function PublicPerpsRoute() {
  const { address } = Route.useParams()
  const navigate = Route.useNavigate()
  return (
    <Frame
      status={{ start: 'Phoenix data · read-only' }}
      mainClassName="pt-5 pb-12 sm:pt-7"
    >
      {isAddress(address) ? (
        <PerpsPage
          // A new address is a new account; state from the last one is dropped.
          key={address}
          address={address}
          reader={publicPhoenixReader}
          onAddress={(next) =>
            void navigate({
              to: '/perps/$address',
              params: { address: next },
            })
          }
        />
      ) : (
        <p className="d-empty mt-6 font-mono text-[13px]">
          This is not a Solana wallet address.
        </p>
      )}
    </Frame>
  )
}
