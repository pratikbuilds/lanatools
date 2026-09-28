import { expect, test } from 'bun:test'
import { HTTPException } from 'hono/http-exception'
import { HealthResponse } from '@lanatools/contracts'
import { createApp } from './app'
import { readPort } from './config'

test('health returns the shared contract and a request ID', async () => {
  const response = await createApp().request('/api/health')
  expect(response.status).toBe(200)
  expect(HealthResponse.assert(await response.json())).toEqual({ status: 'ok' })
  expect(response.headers.get('x-request-id')).toBeTruthy()
})

test('missing routes and exceptions return consistent, sanitized errors', async () => {
  const app = createApp()
  app.get('/broken', () => {
    throw new Error('private database password')
  })
  app.get('/denied', () => {
    throw new HTTPException(403, { message: 'private authorization details' })
  })
  for (const [path, status, error] of [
    ['/missing', 404, 'Not found'],
    ['/broken', 500, 'Internal server error'],
    ['/denied', 403, 'Request failed'],
  ] as const) {
    const response = await app.request(path)
    expect(response.status).toBe(status)
    const body: unknown = await response.json()
    expect(body).toEqual({
      error,
      requestId: response.headers.get('x-request-id'),
    })
  }
})

test('port configuration defaults and rejects invalid startup values', () => {
  expect(readPort()).toBe(3000)
  expect(readPort('65535')).toBe(65535)
  for (const value of ['', '0', '65536', '3000oops', '3.5', '-1', 'Infinity']) {
    expect(() => readPort(value)).toThrow(
      'PORT must be an integer between 1 and 65535',
    )
  }
})
