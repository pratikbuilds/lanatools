import { expect, test } from '@playwright/test'
import { client, mockDashboard } from '../fixtures/dashboard'

const dashboardURL = 'http://127.0.0.1:4174'

for (const width of [390, 1440]) {
  test(`wallet reload keeps its layout through account and data loading at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await mockDashboard(page)
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/**', async (route) => {
      await pending
      if (new URL(route.request().url()).pathname === '/api/wallet/balances') {
        await route.fulfill({
          json: {
            network: 'devnet',
            sol: '100000000',
            usdc: '12340000',
            tokens: [],
          },
        })
      } else {
        await route.fallback()
      }
    })
    await page.goto(`${dashboardURL}/dashboard?loading`)
    const wallet = page.getByRole('region', { name: 'Payment wallet' })
    await expect(
      page.getByRole('heading', { name: 'Wallet', exact: true }),
    ).toBeVisible()
    await expect(wallet).toHaveAttribute('aria-busy', 'true')
    await expect(
      page.getByRole('button', { name: /Connect a client/ }),
    ).toBeDisabled()
    const before = await wallet.boundingBox()
    await page.evaluate(() =>
      window.dispatchEvent(new Event('test:privy-ready')),
    )
    await expect(
      wallet.getByRole('button', { name: 'Deposit', exact: false }),
    ).toBeEnabled()
    await expect(
      page.getByRole('status', { name: 'Loading connected clients' }),
    ).toBeVisible()
    await expect(
      page.getByRole('status', { name: 'Loading activity' }),
    ).toBeVisible()
    const afterAccount = await wallet.boundingBox()
    expect(afterAccount?.y).toBe(before?.y)
    expect(afterAccount?.height).toBe(before?.height)
    release()
    await expect(wallet).toHaveAttribute('aria-busy', 'false')
    await expect(wallet).toContainText('12.34')
    await expect(
      page
        .getByRole('region', { name: 'Connected clients' })
        .getByRole('button', { name: client.clientName ?? '' }),
    ).toBeVisible()
    await expect(
      page.getByRole('status', { name: 'Loading activity' }),
    ).toHaveCount(0)
    const loaded = await wallet.boundingBox()
    expect(
      Math.abs((loaded?.height ?? 0) - (before?.height ?? 0)),
    ).toBeLessThanOrEqual(1)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.reload()
    await expect(
      page.getByRole('button', { name: /Connect a client/ }),
    ).toBeDisabled()
    await page.evaluate(() =>
      window.dispatchEvent(new Event('test:privy-ready')),
    )
    await expect(wallet).toContainText('12.34')
    expect(errors).toEqual([])
  })
}

for (const pageName of ['Activity', 'Settings']) {
  test(`${pageName} reload shows its own account skeleton`, async ({
    page,
  }) => {
    await mockDashboard(page)
    await page.goto(
      `${dashboardURL}/dashboard/${pageName.toLowerCase()}?loading`,
    )
    await expect(
      page.getByRole('heading', { name: pageName, exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Latest activity', exact: true }),
    ).toHaveCount(0)
    await page.evaluate(() =>
      window.dispatchEvent(new Event('test:privy-ready')),
    )
    await expect(
      page.getByRole('heading', { name: pageName, exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText('Checking your account…', { exact: true }),
    ).toHaveCount(0)
  })
}

test('slow empty results stay loading until the requests resolve', async ({
  page,
}) => {
  await mockDashboard(page, true)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/**', async (route) => {
    await pending
    await route.fallback()
  })
  await page.goto(`${dashboardURL}/dashboard`)
  await expect(
    page.getByRole('status', { name: 'Loading connected clients' }),
  ).toBeVisible()
  await expect(
    page.getByRole('status', { name: 'Loading activity' }),
  ).toBeVisible()
  await expect(page.getByText('No calls yet', { exact: true })).toHaveCount(0)
  await expect(
    page.getByText('Let’s bring in your first agent', { exact: true }),
  ).toHaveCount(0)
  release()
  await expect(page.getByText('No calls yet', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Let’s bring in your first agent', { exact: true }),
  ).toBeVisible()
})

test('failed background refreshes retain the loaded clients and calls', async ({
  page,
}) => {
  test.setTimeout(40_000)
  await mockDashboard(page)
  await page.goto(`${dashboardURL}/dashboard`)
  const clients = page.getByRole('region', { name: 'Connected clients' })
  const activity = page.getByRole('region', { name: 'Latest activity' })
  await expect(
    clients.getByRole('button', { name: client.clientName ?? '' }),
  ).toBeVisible()
  await expect(
    activity.getByRole('button', { name: /helius_getAssetsByOwner/ }),
  ).toBeVisible()
  await page.route('**/api/mcp/clients', (route) =>
    route.fulfill({ status: 500, json: { error: 'Refresh failed' } }),
  )
  await page.route('**/api/activity?*', (route) =>
    route.fulfill({ status: 500, json: { error: 'Refresh failed' } }),
  )
  await expect(clients.getByRole('alert')).toContainText(
    'Showing the last loaded data',
    { timeout: 30_000 },
  )
  await expect(activity.getByRole('alert')).toContainText(
    'Showing the last loaded data',
  )
  await expect(
    clients.getByRole('button', { name: client.clientName ?? '' }),
  ).toBeVisible()
  await expect(
    activity.getByRole('button', { name: /helius_getAssetsByOwner/ }),
  ).toBeVisible()
  await expect(page.getByRole('status', { name: /^Loading/ })).toHaveCount(0)
})
