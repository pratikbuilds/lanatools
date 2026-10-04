import { rank, scoreEndpoint, searchScope } from './keyword'
import { describeEndpoint, listing, topEndpoints } from './shape'
import {
  MAX_CHOICE_OPTIONS,
  TypeSafeError,
  askJev,
  choice,
  noul,
} from './typesafe'
import type { SearchInput } from './keyword'
import type { Catalog, CatalogProvider, Endpoint } from './source'
import type { JevOpts, Question } from './typesafe'

// Follows TypeSafe's skill-suggestion cookbook: one wide Choice over every
// provider, then one request that re-checks a shortlist with full detail.
// The shortlist size and fit threshold are the cookbook's starting values;
// tune them with `scripts/eval.ts`.
export const SHORTLIST = 3
export const FITS_THRESHOLD = 0.3
// No fqn (it always has a slash) or `METHOD path` key (it always has a
// space) can be spelled like this.
const NONE = 'none'

function providerOption(provider: CatalogProvider) {
  return {
    title: provider.title,
    description: provider.description,
    ...(provider.use_case ? { use_case: provider.use_case } : {}),
    category: provider.category,
  }
}

const endpointKey = (endpoint: Endpoint) =>
  `${endpoint.method.toUpperCase()} ${endpoint.path}`

// Jev leans toward options listed first, so options are always ordered by
// name and never by another ranker's opinion.
const byName = (a: CatalogProvider, b: CatalogProvider) =>
  a.fqn.localeCompare(b.fqn)

/**
 * Ranks providers and endpoints for a task with TypeSafe's Jev model.
 *
 * Request 1 asks one Choice over every provider in scope. Its top
 * candidates, plus the keyword ranker's top candidates (which still win
 * when the task names a provider), go to request 2. That request re-ranks
 * them with their usage notes, asks of each whether it can do the task at
 * all, and picks each one's endpoint. Candidates that fail the fit check
 * are dropped, so a task nothing in the catalog serves returns no providers.
 */
export async function jevSearch(
  catalog: Catalog,
  input: SearchInput,
  jev: JevOpts,
) {
  const { query, terms, providers } = searchScope(catalog, input)
  if (providers.length === 0)
    return { providers: [], calls: [], shortlist: [], none: 0 }
  if (providers.length >= MAX_CHOICE_OPTIONS)
    throw new TypeSafeError(
      `${providers.length} providers do not fit in one Choice question`,
    )
  const state = { task: input.query }

  const wide = await askJev(jev, state, {
    provider: choice("Which provider's API can carry out `task`?", {
      ...Object.fromEntries(
        [...providers].sort(byName).map((p) => [p.fqn, providerOption(p)]),
      ),
      [NONE]: 'None of these providers can carry out `task`.',
    }),
  })
  const wideOdds = wide.probabilities('provider')
  const candidates = [
    ...new Set([
      ...[...providers]
        .sort((a, b) => (wideOdds[b.fqn] ?? 0) - (wideOdds[a.fqn] ?? 0))
        .slice(0, SHORTLIST),
      ...rank(providers, new Map(), query, terms, SHORTLIST).map(
        ({ provider }) => provider,
      ),
    ]),
  ].sort(byName)

  const questions: Record<string, Question> = {}
  if (candidates.length > 1)
    questions.provider = choice(
      'Which of these providers is the best fit for `task`? Read what each one actually does, not just its name.',
      Object.fromEntries(
        candidates.map((provider) => [
          provider.fqn,
          {
            ...providerOption(provider),
            ...(provider.content ? { usage_notes: provider.content } : {}),
          },
        ]),
      ),
    )
  for (const provider of candidates) {
    questions[`fits:${provider.fqn}`] = noul(
      {
        provider: providerOption(provider),
        question:
          'Can `provider` carry out the specific thing `task` asks for?',
      },
      {
        true: 'Its API does what `task` asks for.',
        false:
          'It only works in a related area, or its API cannot do what `task` asks for.',
      },
    )
    const { endpoints } = provider
    if (endpoints.length > 1 && endpoints.length < MAX_CHOICE_OPTIONS)
      questions[`endpoint:${provider.fqn}`] = choice(
        `Which ${provider.title} endpoint carries out \`task\`?`,
        {
          ...Object.fromEntries(
            endpoints.map((e) => [
              endpointKey(e),
              e.resource
                ? { description: e.description, resource: e.resource }
                : e.description,
            ]),
          ),
          [NONE]: 'None of these endpoints carries out `task`.',
        },
      )
  }
  const narrow = await askJev(jev, state, questions)
  const odds = 'provider' in questions ? narrow.probabilities('provider') : null

  const ranked = candidates
    .map((provider) => ({
      provider,
      fits: narrow.noul(`fits:${provider.fqn}`),
      probability: odds ? (odds[provider.fqn] ?? 0) : null,
    }))
    .filter((candidate) => candidate.fits >= FITS_THRESHOLD)
    .sort(
      (a, b) => (b.probability ?? 0) - (a.probability ?? 0) || b.fits - a.fits,
    )
    .slice(0, input.maxResults)
    .map(({ provider, fits, probability }) => {
      const key = `endpoint:${provider.fqn}`
      const endpointOdds = key in questions ? narrow.probabilities(key) : null
      // Without an endpoint question (one endpoint, or too many for one
      // Choice), endpoints keep their keyword order.
      const match = (endpoint: Endpoint) =>
        endpointOdds
          ? (endpointOdds[endpointKey(endpoint)] ?? 0)
          : scoreEndpoint(endpoint, query, terms)
      return {
        ...listing(provider),
        fits,
        probability,
        endpoints: topEndpoints(provider.endpoints, match).map(
          ({ endpoint }) => ({
            ...describeEndpoint(provider, endpoint),
            probability: endpointOdds
              ? (endpointOdds[endpointKey(endpoint)] ?? 0)
              : null,
          }),
        ),
      }
    })

  return {
    providers: ranked,
    // Kept for the local scripts: what each request cost and what Jev saw.
    calls: [wide, narrow].map(({ model, usage, ms }) => ({
      model,
      ms,
      ...usage,
    })),
    shortlist: candidates.map((provider) => ({
      fqn: provider.fqn,
      wide: wideOdds[provider.fqn] ?? 0,
      fits: narrow.noul(`fits:${provider.fqn}`),
    })),
    none: wideOdds[NONE] ?? 0,
  }
}
