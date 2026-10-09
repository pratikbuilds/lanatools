import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { getPlatformProxy } from 'wrangler'
import type { D1Database } from '@cloudflare/workers-types'

async function checkTransactionLinks() {
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: new URL('../wrangler.local.jsonc', import.meta.url).pathname,
    persist: {
      path: new URL('../.wrangler/state/v3', import.meta.url).pathname,
    },
  })
  const db = proxy.env.DB
  const id = `smoke-${crypto.randomUUID()}`
  const now = Date.now()
  try {
    const insert = () =>
      db
        .prepare(
          `
      INSERT INTO transaction_link
        (id, tool_name, arguments_json, network, creator_user_id, creator_client_id,
         creator_grant_id, idempotency_key, created_at, updated_at, expires_at)
      VALUES (?, 'smoke', '{}', 'devnet', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (creator_user_id, creator_client_id, idempotency_key) DO NOTHING
    `,
        )
        .bind(id, id, id, id, id, now, now, now + 60_000)
    const inserted = await insert().run()
    const repeated = await insert().run()
    if (inserted.meta.changes !== 1 || repeated.meta.changes !== 0)
      throw new Error('Transaction link idempotency index failed')
    const reserved = await db
      .prepare(
        `
      UPDATE transaction_link SET status = 'preparing', revision = 1, account = 'smoke-wallet'
      WHERE id = ? AND status = 'open' AND revision = 0 AND candidate_json IS NULL
    `,
      )
      .bind(id)
      .run()
    const published = await db
      .prepare(
        `
      UPDATE transaction_link SET status = 'ready', revision = 2, candidate_json = '{}'
      WHERE id = ? AND status = 'preparing' AND revision = 1
    `,
      )
      .bind(id)
      .run()
    const stale = await db
      .prepare(
        `
      UPDATE transaction_link SET status = 'open', account = NULL
      WHERE id = ? AND revision = 1 AND candidate_json IS NULL
    `,
      )
      .bind(id)
      .run()
    const accepted = await db
      .prepare(
        `
      UPDATE transaction_link SET status = 'submitting', revision = 3, signature = 'smoke-signature'
      WHERE id = ? AND status = 'ready' AND revision = 2 AND signature IS NULL
    `,
      )
      .bind(id)
      .run()
    const competing = await db
      .prepare(
        `
      UPDATE transaction_link SET signature = 'replacement-signature'
      WHERE id = ? AND status = 'ready' AND revision = 2 AND signature IS NULL
    `,
      )
      .bind(id)
      .run()
    await db
      .prepare(`UPDATE transaction_link SET status = 'confirmed' WHERE id = ?`)
      .bind(id)
      .run()
    const downgrade = await db
      .prepare(
        `
      UPDATE transaction_link SET status = 'unknown'
      WHERE id = ? AND signature = 'smoke-signature' AND status IN ('submitting', 'unknown')
    `,
      )
      .bind(id)
      .run()
    const row = await db
      .prepare('SELECT status, signature FROM transaction_link WHERE id = ?')
      .bind(id)
      .first<{ status: string; signature: string }>()
    if (
      reserved.meta.changes !== 1 ||
      published.meta.changes !== 1 ||
      stale.meta.changes !== 0 ||
      accepted.meta.changes !== 1 ||
      competing.meta.changes !== 0 ||
      downgrade.meta.changes !== 0 ||
      row?.status !== 'confirmed' ||
      row.signature !== 'smoke-signature'
    )
      throw new Error('Transaction link conditional persistence failed')
    console.info(
      'Local D1 transaction link uniqueness, revision fences and signature persistence passed',
    )
  } finally {
    try {
      await db
        .prepare('DELETE FROM transaction_link WHERE id = ?')
        .bind(id)
        .run()
    } finally {
      await proxy.dispose()
    }
  }
}

const port = 3102
const url = `http://127.0.0.1:${port}`
const worker = spawn(
  'wrangler',
  ['dev', '-c', 'wrangler.local.jsonc', '--port', String(port), '--local'],
  {
    cwd: new URL('../', import.meta.url),
    stdio: ['ignore', 'ignore', 'inherit'],
  },
)

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error('Local Worker exited')
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) break
    } catch {
      // Wrangler is starting.
    }
    if (attempt === 99) throw new Error('Local Worker did not start')
    await Bun.sleep(100)
  }

  const written = await fetch(`${url}/api/db-smoke`, { method: 'POST' })
  if (!written.ok) throw new Error(`D1 write failed: ${written.status}`)
  const body: unknown = await written.json()
  if (!body || typeof body !== 'object' || !('id' in body))
    throw new Error('D1 write returned no ID')
  const id = body.id
  if (typeof id !== 'string') throw new Error('D1 write returned no ID')

  const read = await fetch(`${url}/api/db-smoke/${id}`)
  const readBody: unknown = await read.json()
  if (
    !read.ok ||
    typeof readBody !== 'object' ||
    readBody === null ||
    !('id' in readBody) ||
    readBody.id !== id
  )
    throw new Error('D1 read did not match the write')
  if (worker.exitCode !== null) throw new Error('Local Worker exited')
  console.info('Local Worker D1 write/read passed')
  await checkTransactionLinks()
} finally {
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, 'exit')
    worker.kill('SIGTERM')
    await exited
  }
}
