import { Skeleton } from './skeleton'

export const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-3.5 lg:grid-cols-[minmax(9rem,1.5fr)_minmax(9rem,1.7fr)_5.5rem_9.5rem_4.9rem] lg:gap-4 lg:px-4'

export function ClientSkeleton() {
  return (
    <div role="status" aria-label="Loading connected clients">
      <div className="d-card" aria-hidden="true">
        <div className={`${ROW} d-th hidden min-h-9 lg:grid`}>
          {['Client', 'Spend / limit', 'Remaining', 'Activity'].map((label) => (
            <span key={label} className="d-label">
              {label}
            </span>
          ))}
          <span />
        </div>
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className={`${ROW} min-h-[54px] border-t border-line py-3 lg:py-2.5`}
          >
            <Skeleton className="h-3.5 w-32 max-w-full" />
            <Skeleton className="col-span-2 row-start-2 h-6 w-full lg:col-span-1 lg:row-auto" />
            <Skeleton className="col-start-2 row-start-1 h-3.5 w-16 lg:col-auto lg:row-auto" />
            <Skeleton className="col-span-2 row-start-3 h-6 w-24 lg:col-span-1 lg:row-auto" />
            <Skeleton className="hidden h-6 w-16 lg:block" />
          </div>
        ))}
      </div>
    </div>
  )
}
