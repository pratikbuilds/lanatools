import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, test } from '@playwright/test'

test('connects to the real API and recovers after an outage', async ({
  page,
}) => {
  function startAPI() {
    return spawn('bun', ['apps/api/dist/index.js'], {
      env: { ...process.env, PORT: '3101' },
      stdio: 'pipe',
    })
  }
  let api = startAPI()
  async function ready() {
    await expect
      .poll(async () => {
        if (api.exitCode !== null)
          throw new Error('Test API exited before readiness')
        try {
          return (await fetch('http://127.0.0.1:3101/api/health')).status
        } catch {
          return 0
        }
      })
      .toBe(200)
    expect(api.exitCode).toBeNull()
  }
  async function stopAPI() {
    if (api.exitCode === null && api.signalCode === null) {
      const exited = once(api, 'exit')
      api.kill('SIGTERM')
      await exited
    }
  }
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await ready()
    await page.route(
      '**/api/health',
      async (route) => {
        await expect(page.getByRole('status')).toHaveText(
          'Checking connection…',
        )
        await route.continue()
      },
      { times: 1 },
    )
    await page.goto('/')
    await expect(page.getByRole('status')).toHaveText('Service connected.')
    expect(errors).toEqual([])

    await stopAPI()
    await page.reload()
    await expect(page.getByRole('status')).toHaveText(
      'Unable to connect to the service.',
    )
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()

    api = startAPI()
    await ready()
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('status')).toHaveText('Service connected.')
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    await stopAPI()
  }
})

test('does not report a connection before an offline query can run', async ({
  page,
  context,
}) => {
  await page.goto('/missing')
  await expect(page.getByText('Not Found', { exact: true })).toBeVisible()
  // Deliver the route chunk as if cached; the browser remains offline for API requests.
  await page.route('**/assets/*.js', async (route) => {
    await route.fulfill({ response: await route.fetch() })
  })
  await context.setOffline(true)
  await page.evaluate(() => {
    window.history.pushState(null, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await expect(page.getByRole('status')).toHaveText('Waiting for connection…')
  await expect(
    page.getByText('Service connected.', { exact: true }),
  ).toHaveCount(0)
})
