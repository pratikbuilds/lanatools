import {
  ArrowRightIcon,
  CaretDownIcon,
  MagnifyingGlassIcon,
} from '@phosphor-icons/react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { formatUsd } from '@lanatools/contracts'
import type { CatalogEndpoint, CatalogProvider } from '@lanatools/contracts'
import { getCatalogEntry, listCatalog, searchCatalog } from '#/lib/catalog'
import { CopyStatus, copyLabel, useCopy } from '../landing/copy-url'
import { PageHead } from './page-head'
import { useDashboardSession } from './session'
import { Skeleton } from './skeleton'

const EXAMPLES = [
  { label: 'Create an image', task: 'Generate an image from a text prompt' },
  { label: 'Search the web', task: 'Search the web for recent news' },
  { label: 'Find local places', task: 'Find restaurants near me' },
]
const CATEGORY_NAMES: Record<string, string> = {
  ai_ml: 'AI & machine learning',
  devtools: 'Developer tools',
}
const categoryName = (category: string) =>
  CATEGORY_NAMES[category] ??
  `${category[0]?.toUpperCase() ?? ''}${category.slice(1).replaceAll('_', ' ')}`

export function PaymentsPage() {
  const { userId, getAccessToken } = useDashboardSession()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string>()
  const catalog = useQuery({
    queryKey: ['catalog', userId],
    queryFn: () => listCatalog(getAccessToken),
    staleTime: Infinity,
  })
  const search = useMutation({
    mutationFn: (task: string) => searchCatalog(getAccessToken, task, category),
  })
  const providers =
    search.data?.providers ??
    catalog.data?.categories
      .filter((group) => !category || group.category === category)
      .flatMap((group) => group.providers)
      .sort((a, b) => a.title.localeCompare(b.title)) ??
    []
  const active =
    providers.find((provider) => provider.fqn === selected) ?? providers[0]
  const match = search.data?.providers.find(
    (provider) => provider.fqn === active?.fqn,
  )

  function browse() {
    search.reset()
    setSelected(undefined)
  }
  function runSearch(task: string) {
    const trimmed = task.trim()
    if (!trimmed || search.isPending) return
    setQuery(task)
    setSelected(undefined)
    search.mutate(trimmed)
  }

  return (
    <>
      <PageHead title="Payments">
        {catalog.data && (
          <span className="ml-auto text-[12px] text-fg-3">
            {catalog.data.provider_count} providers
          </span>
        )}
      </PageHead>
      <p className="mt-1 text-[13px] text-fg-2">
        Find paid APIs for a task, then inspect their endpoints and pricing.
      </p>
      <div className="mt-4 overflow-hidden rounded-[12px] border border-line-2 bg-panel">
        <section aria-label="Find a payment endpoint">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              runSearch(query)
            }}
            className="flex items-center gap-3 border-b-2 border-line-2 bg-panel-2 px-3 transition-colors focus-within:border-accent"
          >
            <label htmlFor="payment-task" className="sr-only">
              What do you need to do?
            </label>
            <MagnifyingGlassIcon
              size={19}
              className="shrink-0 text-fg"
              aria-hidden="true"
            />
            <input
              id="payment-task"
              type="search"
              placeholder="Search by task or provider…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={1000}
              disabled={search.isPending}
              className="d-input h-12 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-[16px] placeholder:text-fg-2"
            />
            <button
              type="submit"
              disabled={!query.trim() || search.isPending}
              aria-label={
                search.isPending ? 'Finding endpoints…' : 'Find endpoints'
              }
              className="d-btn d-btn-primary h-8 shrink-0 gap-1.5 px-2.5 text-[12px] [font-family:inherit]"
            >
              {search.isPending ? 'Searching…' : 'Search'}
              <ArrowRightIcon size={14} aria-hidden="true" />
            </button>
          </form>
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1 text-[12px]"
            aria-label="Example tasks"
          >
            <span className="text-fg-3">Try:</span>
            {EXAMPLES.map(({ label, task }) => (
              <button
                key={task}
                type="button"
                disabled={search.isPending}
                onClick={() => runSearch(task)}
                className="min-h-8 text-fg-2 underline-offset-4 transition-colors hover:text-fg hover:underline disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
        </section>
        <section
          aria-label="Payment endpoints"
          aria-busy={search.isPending}
          className="min-w-0"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2">
            <h2 className="text-[13px] font-semibold">
              {search.isIdle ? 'Browse providers' : 'Search results'}
            </h2>
            <select
              aria-label="Category"
              value={category}
              disabled={search.isPending}
              onChange={(event) => {
                setCategory(event.target.value)
                browse()
              }}
              className="d-input ml-auto h-7 max-w-[11rem] cursor-pointer border-0 bg-transparent px-1 text-[12px] sm:max-w-[14rem]"
            >
              <option value="">All categories</option>
              {catalog.data?.categories.map((group) => (
                <option key={group.category} value={group.category}>
                  {categoryName(group.category)}
                </option>
              ))}
            </select>
            {!search.isIdle && (
              <button
                type="button"
                disabled={search.isPending}
                onClick={browse}
                className="min-h-8 text-[12px] text-fg-2 underline underline-offset-4"
              >
                Browse all
              </button>
            )}
          </div>
          {search.isPending ? (
            <div
              role="status"
              aria-label="Finding endpoints"
              className="grid gap-4 p-3 lg:grid-cols-[224px_1fr]"
            >
              <span className="sr-only">
                Finding providers and endpoints for your task…
              </span>
              <div className="space-y-5">
                {[0, 1, 2].map((row) => (
                  <div key={row}>
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="mt-2 h-3 w-1/2" />
                  </div>
                ))}
              </div>
              <div className="space-y-4">
                <Skeleton className="h-7 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-24 w-full" />
              </div>
            </div>
          ) : search.isError ? (
            <p role="alert" className="py-6 text-[13px] text-bad">
              {search.error.message}
            </p>
          ) : catalog.isPending && !search.data ? (
            <div
              role="status"
              aria-label="Loading providers"
              className="space-y-3 py-5"
            >
              <span className="sr-only">Loading providers…</span>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : catalog.isError && !search.data ? (
            <p role="alert" className="py-6 text-[13px] text-bad">
              Could not load the catalog.{' '}
              <button
                type="button"
                className="underline"
                onClick={() => void catalog.refetch()}
              >
                Try again
              </button>
            </p>
          ) : (
            <>
              {search.data && (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-2 text-[12px] text-fg-2"
                >
                  <span className="font-medium text-fg">
                    {search.data.ranker === 'jev'
                      ? 'Matched by Jev'
                      : 'Keyword search'}
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    Results for "{search.variables}"
                  </span>
                  {search.data.ranker === 'keyword' && (
                    <span>Jev is unavailable for this search.</span>
                  )}
                </div>
              )}
              {active ? (
                <div className="grid lg:grid-cols-[224px_minmax(0,1fr)]">
                  <div
                    className={`${search.data ? 'order-last lg:order-first' : ''} min-w-0 border-t border-line-2 bg-surface lg:border-t-0 lg:border-r`}
                  >
                    <div className="flex items-center justify-between border-b border-line px-3 py-2 text-[12px] text-fg-2">
                      <span>
                        {search.data
                          ? 'Matching providers'
                          : category
                            ? categoryName(category)
                            : 'All providers'}
                      </span>
                      <span className="font-mono tabular-nums">
                        {providers.length}
                      </span>
                    </div>
                    <ul
                      aria-label="Providers"
                      className="max-h-[300px] overflow-y-auto lg:max-h-[550px]"
                    >
                      {providers.map((provider, index) => (
                        <li
                          key={provider.fqn}
                          className="border-b border-line last:border-0"
                        >
                          <button
                            type="button"
                            aria-pressed={active.fqn === provider.fqn}
                            onClick={() => setSelected(provider.fqn)}
                            className={`group flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${active.fqn === provider.fqn ? 'bg-accent text-on-accent' : 'hover:bg-panel-2'}`}
                          >
                            {search.data && (
                              <span className="w-4 shrink-0 font-mono text-[12px] tabular-nums text-fg-2 group-aria-pressed:text-on-accent">
                                {index + 1}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span
                                className="line-clamp-2 text-[13px] leading-snug font-semibold"
                                title={provider.title}
                              >
                                {provider.title}
                              </span>
                              <span className="mt-0.5 block text-[12px] text-fg-2 group-aria-pressed:text-on-accent">
                                {provider.endpoint_count} endpoints
                              </span>
                            </span>
                            <ArrowRightIcon
                              size={15}
                              className="shrink-0 text-fg-2 group-aria-pressed:text-on-accent"
                              aria-hidden="true"
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <ProviderPreview
                    key={`${search.variables ?? 'browse'}:${active.fqn}`}
                    fqn={active.fqn}
                    match={match}
                    topMatch={search.data?.providers[0]?.fqn === active.fqn}
                  />
                </div>
              ) : (
                <div className="py-12 text-center">
                  <MagnifyingGlassIcon
                    size={28}
                    className="mx-auto text-fg-3"
                    aria-hidden="true"
                  />
                  <h3 className="mt-4 font-mono text-[16px] font-semibold">
                    No matching endpoints
                  </h3>
                  <p className="mx-auto mt-2 max-w-[40ch] text-[14px] text-fg-2">
                    The catalog has no match for this task. Browse providers to
                    see what is available.
                  </p>
                </div>
              )}
            </>
          )}
          <p className="border-t border-line px-3 py-2 text-[12px] text-fg-2">
            Search uses Jev when available. Browsing and searching do not spend
            from your wallet.
          </p>
        </section>
      </div>
    </>
  )
}

function ProviderPreview({
  fqn,
  match,
  topMatch,
}: {
  fqn: string
  match: CatalogProvider | undefined
  topMatch: boolean
}) {
  const { userId, getAccessToken } = useDashboardSession()
  const [showAll, setShowAll] = useState(false)
  const entry = useQuery({
    queryKey: ['catalog-entry', userId, fqn],
    queryFn: () => getCatalogEntry(getAccessToken, fqn),
    staleTime: Infinity,
    enabled: !match || showAll,
  })
  const provider = showAll || !match ? entry.data : match
  const pending = (!match || showAll) && entry.isPending
  return (
    <article aria-label="Provider endpoints" className="min-w-0 bg-panel-2">
      {pending ? (
        <div
          role="status"
          aria-label="Loading endpoints"
          className="space-y-4 p-5 sm:p-7"
        >
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : entry.isError && (!match || showAll) ? (
        <p role="alert" className="p-6 text-bad">
          Could not load the endpoints.{' '}
          <button
            type="button"
            className="underline"
            onClick={() => void entry.refetch()}
          >
            Try again
          </button>
        </p>
      ) : (
        provider && (
          <>
            <div className="px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-[17px] leading-snug font-semibold [overflow-wrap:anywhere]">
                  {provider.title}
                </h3>
                {topMatch && (
                  <span className="rounded bg-panel px-1.5 py-0.5 text-[12px] font-medium text-fg">
                    Best match
                  </span>
                )}
              </div>
              <details className="mt-1 text-fg-2">
                <summary className="cursor-pointer text-[12px] underline-offset-4 hover:underline">
                  About this provider
                </summary>
                <p className="mt-2 max-w-[65ch] text-[14px] leading-relaxed [overflow-wrap:anywhere]">
                  {provider.description}
                </p>
                <p className="mt-2 font-mono text-[11px] text-fg-2 [overflow-wrap:anywhere]">
                  {provider.fqn} · {categoryName(provider.category)}
                </p>
              </details>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-y border-line-2 bg-panel px-3 py-1.5 text-[12px] text-fg-2">
              <h4 className="font-semibold text-fg">
                Endpoints{' '}
                <span className="ml-1 font-normal text-fg-2">
                  {provider.endpoints.length}
                </span>
              </h4>
              {match &&
              (showAll || match.endpoint_count > match.endpoints.length) ? (
                <button
                  type="button"
                  className="text-fg-2 underline underline-offset-4"
                  onClick={() => setShowAll(!showAll)}
                >
                  {showAll
                    ? 'Show matches'
                    : `All ${match.endpoint_count} endpoints`}
                </button>
              ) : (
                <span>Estimated price</span>
              )}
            </div>
            <div
              role="region"
              aria-label="Endpoints"
              className="max-h-[460px] overflow-y-auto px-3"
            >
              {provider.endpoints.map((endpoint, index) => (
                <Endpoint
                  key={`${endpoint.method} ${endpoint.path}`}
                  endpoint={endpoint}
                  expanded={index === 0}
                />
              ))}
            </div>
            <p className="border-t border-line-2 bg-panel px-3 py-2 text-[12px] text-fg-2">
              Prices are catalog estimates. Confirm pricing at the endpoint.
            </p>
          </>
        )
      )}
    </article>
  )
}

function priceLabel(price: CatalogEndpoint['price_usd']) {
  if (!price) return 'Price not listed'
  const min = formatUsd(Math.round(price.min * 1_000_000))
  return price.min === price.max
    ? min
    : `${min}–${formatUsd(Math.round(price.max * 1_000_000))}`
}

function Endpoint({
  endpoint,
  expanded,
}: {
  endpoint: CatalogEndpoint
  expanded: boolean
}) {
  const { state, copy } = useCopy(endpoint.url)
  return (
    <details
      open={expanded}
      className="group border-b border-line last:border-b-0"
    >
      <summary className="flex cursor-pointer list-none items-start gap-2 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] font-semibold text-on-accent">
              {endpoint.method}
            </span>
            <span className="font-mono text-[13px] leading-5 font-medium text-fg [overflow-wrap:anywhere] sm:text-[14px] sm:font-semibold">
              {endpoint.path || '/'}
            </span>
          </span>
          {endpoint.description && (
            <span className="mt-1 block text-[13px] leading-snug text-fg [overflow-wrap:anywhere]">
              {endpoint.description}
            </span>
          )}
        </span>
        <span
          className={`shrink-0 text-[12px] tabular-nums ${endpoint.price_usd ? 'font-semibold text-fg' : 'text-fg-2'}`}
          title={endpoint.price_usd ? 'Estimated price' : 'Price unavailable'}
        >
          {endpoint.price_usd && (
            <span className="sr-only">Estimated price: </span>
          )}
          {priceLabel(endpoint.price_usd)}
        </span>
        <CaretDownIcon
          size={13}
          className="mt-1 shrink-0 text-fg-3 transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="pb-2.5">
        <div className="flex items-start gap-3">
          <p className="min-w-0 flex-1 font-mono text-[12px] leading-5 break-all text-tick">
            {endpoint.url}
          </p>
          <button
            type="button"
            className="shrink-0 text-[12px] leading-5 font-medium text-tick underline underline-offset-4"
            onClick={() => void copy()}
          >
            {copyLabel(state, 'Copy URL')}
          </button>
          <CopyStatus state={state} />
        </div>
        {(endpoint.protocols.length > 0 || endpoint.currencies.length > 0) && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-2">
            {endpoint.protocols.length > 0 && (
              <span>{endpoint.protocols.join(' / ')}</span>
            )}
            {endpoint.currencies.length > 0 && (
              <span>{endpoint.currencies.join(' / ')}</span>
            )}
          </div>
        )}
      </div>
    </details>
  )
}
