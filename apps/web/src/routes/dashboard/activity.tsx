import { createFileRoute } from '@tanstack/react-router'
import { ActivityPage } from '#/components/dashboard/activity'
import { ACTIVITY_OUTCOMES } from '#/lib/activity'
import type { ActivityFilter } from '#/lib/activity'

export const Route = createFileRoute('/dashboard/activity')({
  // The filters live in the address, so a filtered view can be linked to
  // and survives a reload. Anything unrecognised is dropped.
  validateSearch: (search: Record<string, unknown>): ActivityFilter => ({
    client: typeof search.client === 'string' ? search.client : undefined,
    outcome: ACTIVITY_OUTCOMES.find((outcome) => outcome === search.outcome),
  }),
  component: ActivityRoute,
})

function ActivityRoute() {
  const filter = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <ActivityPage
      filter={filter}
      onFilter={(search) => void navigate({ search, replace: true })}
    />
  )
}
