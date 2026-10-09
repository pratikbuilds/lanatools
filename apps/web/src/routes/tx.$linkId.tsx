import { createFileRoute } from '@tanstack/react-router'
import { TransactionReview } from '#/components/transaction-review'

export const Route = createFileRoute('/tx/$linkId')({
  component: TransactionRoute,
})

function TransactionRoute() {
  const { linkId } = Route.useParams()
  return <TransactionReview key={linkId} linkId={linkId} />
}
