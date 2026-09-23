import { useQuery } from '@tanstack/react-query'
import { HealthResponse } from '@lanatools/contracts'

export function ApiStatus() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/health', {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      })
      if (!response.ok) throw new Error('Service unavailable')
      return HealthResponse.assert(await response.json())
    },
    retry: false,
  })

  const settled = !health.isPending && !health.isFetching
  const tone =
    health.fetchStatus === 'paused' || !settled
      ? 'bg-paper-3'
      : health.isError
        ? 'bg-coral'
        : 'bg-lime'

  return (
    <div className="flex flex-wrap items-center gap-3 text-[13px] text-paper-2">
      <span className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`size-2.5 rounded-[2px] border border-paper/60 ${tone}`}
        />
        <span role="status">
          {health.fetchStatus === 'paused'
            ? 'Waiting for connection'
            : !settled
              ? 'Checking the API'
              : health.isError
                ? 'API unreachable'
                : 'API operational'}
        </span>
      </span>
      {health.isError && (
        <button
          type="button"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
          className="arrow-link text-paper disabled:opacity-50"
        >
          Try again
        </button>
      )}
    </div>
  )
}
