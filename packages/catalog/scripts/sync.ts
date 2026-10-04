// Downloads the pay.sh catalog into data/catalog.json. Run it by hand when
// the catalog changes, then review and commit the diff.
import { fetchCatalog } from '../src/source'

const path = new URL('../data/catalog.json', import.meta.url)
const { catalog, dropped } = await fetchCatalog(fetch)
await Bun.write(path, `${JSON.stringify(catalog, null, 2)}\n`)

const endpoints = catalog.providers.reduce(
  (sum, p) => sum + p.endpoints.length,
  0,
)
console.log(
  `Saved ${catalog.providers.length} providers and ${endpoints} endpoints (catalog built ${catalog.generated_at}).`,
)
if (dropped > 0) console.log(`Dropped ${dropped} malformed listings.`)
