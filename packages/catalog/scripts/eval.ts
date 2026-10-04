// Runs every task in eval-tasks.json through Jev and keyword search, using the
// local catalog copy, and prints how often each picks the right provider and
// endpoint and how often it matches a task nothing in the catalog covers.
//
//   bun run catalog:eval
//
// Jev needs TYPESAFE_API_KEY (bun reads it from the repo's .env).
import { z } from 'zod'
import { jevSearch, keywordSearch, localCatalog } from '../src/index'
import { jevOpts, usd } from './shared'

const Tasks = z.array(
  z.object({
    kind: z.enum(['synonym', 'named', 'lookalike', 'uncovered']),
    task: z.string(),
    providers: z.array(z.string()),
    endpoints: z.record(z.string(), z.array(z.string())).optional(),
  }),
)
const tasks = Tasks.parse(
  await Bun.file(new URL('eval-tasks.json', import.meta.url)).json(),
)
const catalog = localCatalog()

// A wrong label would score a ranker against an answer it cannot give.
const known = new Map(catalog.providers.map((p) => [p.fqn, p]))
for (const t of tasks) {
  for (const fqn of [...t.providers, ...Object.keys(t.endpoints ?? {})])
    if (!known.has(fqn)) throw new Error(`"${t.task}": no provider ${fqn}`)
  for (const [fqn, keys] of Object.entries(t.endpoints ?? {}))
    for (const key of keys)
      if (
        !known
          .get(fqn)
          ?.endpoints.some((e) => `${e.method.toUpperCase()} ${e.path}` === key)
      )
        throw new Error(`"${t.task}": ${fqn} has no endpoint ${key}`)
}

type Pick = {
  providers: { fqn: string; endpoints: { method: string; path: string }[] }[]
}
type Score = {
  first: number
  top3: number
  endpoint: number
  endpointTasks: number
  falseMatches: number
}
const blank = (): Score => ({
  first: 0,
  top3: 0,
  endpoint: 0,
  endpointTasks: 0,
  falseMatches: 0,
})

function grade(t: (typeof tasks)[number], pick: Pick, score: Score) {
  const top = pick.providers[0]
  if (t.providers.length === 0) {
    if (top) score.falseMatches += 1
    return top ? `✗ ${top.fqn}` : '✓ none'
  }
  const firstOK = !!top && t.providers.includes(top.fqn)
  if (firstOK) score.first += 1
  if (pick.providers.slice(0, 3).some((p) => t.providers.includes(p.fqn)))
    score.top3 += 1
  let note = ''
  const wanted = top && t.endpoints?.[top.fqn]
  if (wanted) {
    score.endpointTasks += 1
    const e = top.endpoints[0]
    const key = e ? `${e.method.toUpperCase()} ${e.path}` : '-'
    if (wanted.includes(key)) score.endpoint += 1
    else note = ` (endpoint ✗ ${key})`
  }
  return `${firstOK ? '✓' : '✗'} ${top?.fqn ?? 'none'}${note}`
}

const jev = jevOpts()
if (!jev)
  console.log('TYPESAFE_API_KEY is not set: running keyword search only.')
const scores = { jev: blank(), keyword: blank() }
const latencies: number[] = []
let tokens = 0
let failures = 0

for (const t of tasks) {
  const input = { query: t.task, maxResults: 5 }
  const keyword = grade(
    t,
    { providers: keywordSearch(catalog, input) },
    scores.keyword,
  )
  let jevNote = '-'
  if (jev)
    try {
      const result = await jevSearch(catalog, input, jev)
      latencies.push(result.calls.reduce((sum, c) => sum + c.ms, 0))
      tokens += result.calls.reduce((sum, c) => sum + c.input_tokens, 0)
      jevNote = grade(t, result, scores.jev)
    } catch (error) {
      failures += 1
      jevNote = `error: ${error instanceof Error ? error.message : String(error)}`
    }
  console.log(
    `[${t.kind}] ${t.task}\n    jev     ${jevNote}\n    keyword ${keyword}`,
  )
}

const covered = tasks.filter((t) => t.providers.length > 0).length
const uncovered = tasks.length - covered
const pct = (n: number, of: number) =>
  of === 0 ? '-' : `${Math.round((n * 100) / of)}% (${n}/${of})`
console.log('\n                 jev              keyword')
for (const [label, read, of] of [
  ['right provider 1st', (s: Score) => s.first, () => covered],
  ['right provider top 3', (s: Score) => s.top3, () => covered],
  [
    'right endpoint 1st',
    (s: Score) => s.endpoint,
    (s: Score) => s.endpointTasks,
  ],
  ['false match', (s: Score) => s.falseMatches, () => uncovered],
] as const)
  console.log(
    `${label.padEnd(22)} ${(jev ? pct(read(scores.jev), of(scores.jev)) : '-').padEnd(16)} ${pct(read(scores.keyword), of(scores.keyword))}`,
  )
if (jev && latencies.length > 0) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  console.log(
    `\nJev per search: median ${at(0.5)} ms, p95 ${at(0.95)} ms, ${Math.round(tokens / latencies.length)} input tokens (${usd(tokens / latencies.length)})`,
  )
  if (failures > 0) console.log(`Jev errors: ${failures}`)
}
