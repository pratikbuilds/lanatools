import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { client, mockDashboard } from '../fixtures/dashboard'

const dashboardURL = 'http://127.0.0.1:4174'

async function fitsPage(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual((page.viewportSize()?.width ?? 0) + 1)
}

async function fitsDialog(dialog: Locator) {
  await expect(dialog).toBeInViewport()
  expect(
    await dialog.evaluate((element) => {
      const box = element.getBoundingClientRect()
      return (
        element.scrollWidth <= element.clientWidth + 1 &&
        box.left >= 0 &&
        box.top >= 0 &&
        box.right <= innerWidth + 1 &&
        box.bottom <= innerHeight + 1
      )
    }),
  ).toBe(true)
  await expect(
    dialog.getByRole('button', { name: 'Close', exact: true }),
  ).toBeInViewport()
}

for (const width of [320, 390, 640, 768, 1024, 1440]) {
  test(`dashboard pages and dialogs fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await mockDashboard(page)
    await page.goto(`${dashboardURL}/dashboard?loading`)
    await expect(
      page
        .getByRole('status', { name: '' })
        .filter({ hasText: 'Opening your dashboard' }),
    ).toBeAttached()
    await fitsPage(page)
    await page.goto(`${dashboardURL}/dashboard`)
    await expect(
      page
        .getByRole('region', { name: 'Connected clients' })
        .getByRole('button', { name: client.clientName ?? '' }),
    ).toBeVisible()
    await fitsPage(page)
    for (const name of [
      'Wallet',
      'Payments',
      'Activity',
      'Transactions',
      'Settings',
    ]) {
      await expect(
        page.getByRole('link', { name, exact: true }),
      ).toBeInViewport()
    }
    await page.getByRole('button', { name: /^Account,/ }).click()
    await expect(page.getByRole('menu')).toBeInViewport()
    await fitsPage(page)
    await page.keyboard.press('Escape')

    for (const name of ['Deposit', 'Withdraw', 'Connect a client']) {
      await page
        .getByRole('button', { name: new RegExp(name) })
        .first()
        .click()
      const dialog = page.getByRole('dialog')
      await fitsDialog(dialog)
      if (name === 'Connect a client') {
        for (const agent of ['Codex', 'Claude', 'Cursor', 'Other agents']) {
          await dialog
            .getByRole('button', { name: new RegExp(agent, 'i') })
            .first()
            .click()
          await fitsDialog(dialog)
        }
      }
      if (name === 'Withdraw') {
        await dialog.getByPlaceholder('Solana address').fill('not-an-address')
        await dialog.getByPlaceholder('0.00').fill('1')
        await expect(dialog.getByRole('alert')).toContainText(
          'valid Solana address',
        )
      }
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    }

    await page
      .getByRole('region', { name: 'Connected clients' })
      .getByRole('button', { name: client.clientName ?? '' })
      .click()
    const drawer = page.getByRole('dialog')
    await fitsDialog(drawer)
    await drawer
      .getByRole('textbox', { name: 'New spending limit in USD' })
      .fill('999999.123456')
    await fitsDialog(drawer)
    await drawer.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('link', { name: 'Activity', exact: true }).click()
    await expect(
      page.getByRole('button', { name: /helius_getAssetsByOwner/ }),
    ).toBeVisible()
    await fitsPage(page)
    await page.getByRole('button', { name: /helius_getAssetsByOwner/ }).click()
    await fitsDialog(page.getByRole('dialog'))
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: 'Agent payments' }),
    ).toBeVisible()
    await fitsPage(page)
    expect(errors).toEqual([])
  })
}

test('empty client setup and short-screen dialogs fit a small phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 480 })
  await mockDashboard(page, true)
  await page.goto(`${dashboardURL}/dashboard`)
  await expect(
    page.getByText('Let’s bring in your first agent', { exact: true }),
  ).toBeVisible()
  await fitsPage(page)
  await page
    .getByRole('button', { name: /Connect a client/ })
    .first()
    .click()
  await fitsDialog(page.getByRole('dialog'))
  const codex = page.getByRole('dialog').getByRole('button', { name: /Codex/ })
  await codex.click()
  await page
    .getByRole('dialog')
    .getByText('When you approve the client', { exact: false })
    .scrollIntoViewIfNeeded()
  await fitsDialog(page.getByRole('dialog'))
})

for (const path of ['/', '/sign-in']) {
  test(`public page ${path} fits a small phone`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 })
    await page.goto(path)
    await expect(page.getByRole('heading').first()).toBeVisible()
    await fitsPage(page)
  })
}
