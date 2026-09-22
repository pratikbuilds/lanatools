import { Hono } from 'hono'
import type { HealthResponse } from '@lanatools/contracts'

export const health = new Hono().get('/', (c) => {
  return c.json({ status: 'ok' } satisfies HealthResponse)
})
