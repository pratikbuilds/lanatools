import { createFileRoute } from '@tanstack/react-router'
import { TransactionsPage } from '#/components/dashboard/transactions'
import { parseTransactionsSearch } from '#/lib/transactions'

export const Route = createFileRoute('/_account/dashboard/transactions')({
  // The filters live in the address, so a filtered view can be linked to
  // and survives a reload. Anything unrecognised is dropped.
  validateSearch: parseTransactionsSearch,
  component: TransactionsRoute,
})

function TransactionsRoute() {
  const filter = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <TransactionsPage
      filter={filter}
      onFilter={(search) => void navigate({ search, replace: true })}
    />
  )
}
