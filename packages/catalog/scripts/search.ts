// Runs one task through Jev and keyword search, using the local catalog copy.
//
//   bun run catalog:search "generate an image from a text prompt"
//   bun run catalog:search "crypto prices" --category finance --max 3
//   bun run catalog:search "..." --json     exactly what search_catalog returns
//   bun run catalog:search "..." --debug    also Jev's shortlist and scores
//
// Jev needs TYPESAFE_API_KEY (bun reads it from the repo's .env).
import { parseArgs, styleText } from 'node:util'
import {
  TypeSafeError,
  jevSearch,
  keywordSearch,
  localCatalog,
  searchCatalog,
} from '../src/index'
import { jevOpts, usd } from './shared'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    category: { type: 'string' },
    max: { type: 'string', default: '5' },
    json: { type: 'boolean', default: false },
    debug: { type: 'boolean', default: false },
  },
})
const query = positionals.join(' ').trim()
if (!query) {
  console.error(
    'Usage: bun run catalog:search "<task>" [--category c] [--max n] [--json] [--debug]',
  )
  process.exit(1)
}
const input = {
  query,
  category: values.category,
  maxResults: Number(values.max),
}
const catalog = localCatalog()
const jev = jevOpts()

if (values.json) {
  console.log(JSON.stringify(await searchCatalog(catalog, input, jev), null, 2))
  process.exit(0)
}

const bold = (text: string) => styleText('bold', text)
const dim = (text: string) => styleText('dim', text)
const percent = (value: number) => `${Math.round(value * 100)}%`
// Endpoints shown per provider in this view; --json has them all.
const SHOWN_ENDPOINTS = 3

console.log(`\n${bold(query)}\n`)

if (!jev)
  console.log(styleText('yellow', 'Jev skipped: TYPESAFE_API_KEY is not set\n'))
else
  try {
    const result = await jevSearch(catalog, input, jev)
    const ms = result.calls.reduce((sum, call) => sum + call.ms, 0)
    const tokens = result.calls.reduce((sum, c) => sum + c.input_tokens, 0)
    console.log(
      `${styleText(['bold', 'cyan'], 'Jev')}  ${dim(`${(ms / 1000).toFixed(2)} s · ${usd(tokens)}`)}`,
    )
    if (result.providers.length === 0)
      console.log(styleText('yellow', '  No provider can do this task'))
    result.providers.forEach((p, i) => {
      console.log(
        `\n  ${bold(`${i + 1}. ${p.title}`)}  ${dim(p.fqn)}  ${styleText('green', `fits ${percent(p.fits)}`)}`,
      )
      // Hide endpoints Jev gave no chance; the full list is in --json.
      const endpoints = p.endpoints
        .filter((e) => e.probability === null || e.probability >= 0.005)
        .slice(0, SHOWN_ENDPOINTS)
      for (const e of endpoints) {
        const price = e.price_usd ? `$${e.price_usd.min}` : 'no price'
        const odds = e.probability === null ? '' : percent(e.probability)
        console.log(
          `     ${odds.padStart(4)}  ${`${e.method} ${e.path}`.padEnd(44)} ${styleText('yellow', price)}`,
        )
        console.log(`           ${dim(e.url)}`)
      }
    })
    if (values.debug) {
      console.log(dim(`\n  shortlist          first pick   fits`))
      for (const s of result.shortlist)
        console.log(
          dim(
            `  ${s.fqn.padEnd(44)} ${percent(s.wide).padStart(4)}  ${percent(s.fits).padStart(4)}`,
          ),
        )
      console.log(dim(`  "none" in first pick: ${percent(result.none)}`))
      console.log(
        dim(
          `  calls: ${result.calls.map((c) => `${c.ms} ms, ${c.input_tokens} tokens`).join(' | ')} (${result.calls[0]?.model ?? '-'})`,
        ),
      )
    }
  } catch (error) {
    if (!(error instanceof TypeSafeError)) throw error
    console.log(styleText('red', `Jev failed: ${error.message}`))
  }

console.log(`\n${styleText(['bold', 'magenta'], 'Keyword search')}`)
const keyword = keywordSearch(catalog, input)
if (keyword.length === 0) console.log(styleText('yellow', '  No match'))
keyword.forEach((p, i) => console.log(`  ${i + 1}. ${p.title}  ${dim(p.fqn)}`))
console.log()
