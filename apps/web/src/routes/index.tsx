import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { HealthResponse } from '@lanatools/contracts'

export const Route = createFileRoute('/')({ component: Home })

function Home() {
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

  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <p className="text-sm font-medium tracking-widest text-slate-500 uppercase">
        LanaTools
      </p>
      <h1 className="mt-4 text-4xl font-semibold tracking-tight text-slate-950">
        Your workspace starts here.
      </h1>
      <p className="mt-4 text-lg text-slate-600">
        A foundation for your next tool.
      </p>
      <section
        aria-label="Service status"
        className="mt-10 rounded-xl border border-slate-200 bg-white p-6"
      >
        <h2 className="font-medium text-slate-950">Connection status</h2>
        <p role="status" className="mt-2 text-slate-600">
          {health.fetchStatus === 'paused'
            ? 'Waiting for connection…'
            : health.isPending || health.isFetching
              ? 'Checking connection…'
              : health.isError
                ? 'Unable to connect to the service.'
                : 'Service connected.'}
        </p>
        {health.isError && (
          <button
            type="button"
            disabled={health.isFetching}
            onClick={() => void health.refetch()}
            className="mt-4 rounded-md bg-slate-950 px-4 py-2 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950 disabled:opacity-50"
          >
            Try again
          </button>
        )}
      </section>
    </main>
  )
}
