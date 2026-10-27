import type { ReactNode } from 'react'
import { Skeleton } from './skeleton'

export const ROW =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3.5 lg:grid-cols-[5.5rem_minmax(0,1.7fr)_minmax(0,1fr)_4rem_10rem] lg:gap-x-4 lg:px-4'

/** The calls' table: a hatched head over the rows. */
export function CallTable({ children }: { children: ReactNode }) {
  return (
    <div className="d-card">
      <div aria-hidden="true" className={`${ROW} d-th hidden min-h-9 lg:grid`}>
        <span className="d-label">Time</span>
        <span className="d-label">Request</span>
        <span className="d-label">Client</span>
        <span className="d-label">Source</span>
        <span className="d-label text-right">Outcome</span>
      </div>
      {children}
    </div>
  )
}

export function CallSkeleton() {
  return (
    <div role="status" aria-label="Loading activity">
      <div aria-hidden="true">
        <CallTable>
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className={`${ROW} min-h-[54px] border-t border-line py-2`}
            >
              <Skeleton className="h-3 w-16" />
              <Skeleton className="col-span-2 row-start-2 h-3.5 w-48 max-w-full lg:col-span-1 lg:row-auto" />
              <Skeleton className="hidden h-3.5 w-28 lg:block" />
              <Skeleton className="hidden h-3 w-12 lg:block" />
              <Skeleton className="col-start-2 row-start-1 ml-auto h-3.5 w-20 lg:col-auto lg:row-auto" />
            </div>
          ))}
        </CallTable>
      </div>
    </div>
  )
}
