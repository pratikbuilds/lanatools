import { spawn } from 'node:child_process'
import { once } from 'node:events'

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
  if (!read.ok || (await read.json()).id !== id)
    throw new Error('D1 read did not match the write')
  if (worker.exitCode !== null) throw new Error('Local Worker exited')
  console.info('Local Worker D1 write/read passed')
} finally {
  if (worker.exitCode === null && worker.signalCode === null) {
    const exited = once(worker, 'exit')
    worker.kill('SIGTERM')
    await exited
  }
}
