import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { health } from './routes/health'

export function createApp<TBindings extends object = object>() {
  const app = new Hono<{ Bindings: TBindings }>()
  app.use(requestId())
  app.use(logger((message) => console.info(JSON.stringify({ message }))))
  app.route('/api/health', health)
  app.notFound((c) =>
    c.json({ error: 'Not found', requestId: c.get('requestId') }, 404),
  )
  app.onError((error, c) => {
    const status = error instanceof HTTPException ? error.status : 500
    // Client errors such as a missing sign-in are expected, not failures.
    if (status >= 500)
      console.error(
        JSON.stringify({
          requestId: c.get('requestId'),
          error: error.message,
          stack: error.stack,
        }),
      )
    return c.json(
      {
        error: status >= 500 ? 'Internal server error' : 'Request failed',
        requestId: c.get('requestId'),
      },
      status,
    )
  })
  return app
}
