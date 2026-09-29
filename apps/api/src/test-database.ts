import { readdir } from 'node:fs/promises'
import type { D1Database } from '@cloudflare/workers-types'
import { getPlatformProxy } from 'wrangler'

/** A throwaway local D1 database with every migration applied. */
export async function testDatabase() {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: new URL('../wrangler.local.jsonc', import.meta.url).pathname,
    persist: false,
  })
  const db = proxy.env.DB
  const dir = new URL('../drizzle/', import.meta.url)
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    for (const statement of (await Bun.file(new URL(file, dir)).text()).split(
      '--> statement-breakpoint',
    ))
      await db.prepare(statement).run()
  return { db, dispose: () => proxy.dispose() }
}
