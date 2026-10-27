import { formatUsd } from '@lanatools/contracts'
import type { ActivityPage } from '@lanatools/contracts'
import { Skeleton } from './skeleton'

export function ActivityTotals({
  totals,
  pending = false,
}: {
  totals: ActivityPage['totals'] | undefined
  pending?: boolean
}) {
  return (
    <dl className="flex flex-wrap gap-x-14 gap-y-5">
      {(
        [
          ['Spent', totals && formatUsd(totals.spentMicroUsd)],
          ['Calls', totals?.calls.toLocaleString('en-US')],
          [
            'Estimated credits',
            totals?.estimatedCredits.toLocaleString('en-US'),
          ],
        ] as const
      ).map(([label, value]) => (
        <div key={label}>
          <dt className="d-label mb-2">{label}</dt>
          <dd className="font-mono text-[1.75rem] leading-[1.1] font-semibold tracking-[-0.04em]">
            {value ?? (pending ? <Skeleton className="h-[1.1em] w-24" /> : '—')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function HeatmapSkeleton() {
  return <Skeleton className="h-[104px] w-[165px]" />
}
