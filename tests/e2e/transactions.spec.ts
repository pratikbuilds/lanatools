import { expect, test } from '@playwright/test'
import { client, mockDashboard } from '../fixtures/dashboard'

// The mocked dashboard's dev server; a scratch config may move it off 4174.
const dashboardURL = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:4174'

for (const width of [390, 1440]) {
  test(`the Transactions tab lists, filters and opens transactions at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await mockDashboard(page)

    await page.goto(`${dashboardURL}/dashboard`)
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Transactions' })
      .click()
    await expect(page).toHaveURL(/\/dashboard\/transactions$/)
    await expect(
      page.getByRole('heading', { name: 'Transactions', exact: true }),
    ).toBeVisible()

    // Status tabs carry their counts; confirmed rows carry no mark.
    const tabs = page.getByRole('group', { name: 'Filter by status' })
    await expect(
      tabs.getByRole('button', { name: /^Pending 3$/ }),
    ).toBeVisible()
    await expect(tabs.getByRole('button', { name: /^Failed 1$/ })).toBeVisible()
    const rows = page.getByRole('list').first()
    await expect(rows.getByText('Swap USDC for SOL').first()).toBeVisible()
    await expect(rows.getByText('Deposit USDC')).toBeVisible()
    await expect(rows.getByText('≈ 0.0062 SOL received').first()).toBeVisible()
    await expect(rows.getByText('Today')).toBeVisible()
    await expect(
      rows.getByText('Rejected by the chain. Nothing moved.'),
    ).toBeVisible()
    if (width >= 1024) {
      await expect(
        rows.getByText(`${client.clientName} · Embedded`).first(),
      ).toBeVisible()
      const explorer = rows.getByRole('link', { name: /4vJ9…aJe9/ }).first()
      await expect(explorer).toHaveAttribute(
        'href',
        /explorer\.solana\.com\/tx\/4vJ9.*cluster=devnet/,
      )
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1)
    await page.screenshot({
      path: test.info().outputPath('transactions.png'),
      fullPage: true,
    })

    // A row opens the drawer, which explains the status and shows the signature.
    await rows
      .getByRole('button', { name: /Swap USDC for SOL/ })
      .first()
      .click()
    const dialog = page.getByRole('dialog', {
      name: 'Transaction: Swap USDC for SOL',
    })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Confirmed on chain.')).toBeVisible()
    await expect(dialog.getByText('Embedded, no approval')).toBeVisible()
    await expect(dialog.getByText('Your LanaTools wallet')).toBeVisible()
    await expect(
      dialog.getByRole('link', { name: /View on Solana Explorer/ }),
    ).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('drawer.png') })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toBeHidden()

    // A filter goes into the address and into the request.
    const filtered = page.waitForRequest(
      (request) =>
        request.url().includes('/api/transactions?') &&
        request.url().includes('status=failed'),
    )
    await tabs.getByRole('button', { name: /^Failed/ }).click()
    await filtered
    await expect(page).toHaveURL(/status=failed/)
    await page.getByRole('button', { name: 'Clear' }).click()
    await expect(page).toHaveURL(/\/dashboard\/transactions$/)

    const address = page.getByRole('searchbox', { name: 'Filter by address' })
    const byAddress = page.waitForRequest((request) =>
      request.url().includes('address=DRpb'),
    )
    await address.fill('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy')
    await byAddress
    await expect(page).toHaveURL(/address=DRpb/)

    expect(errors).toEqual([])
  })
}

test('an empty wallet explains what will appear', async ({ page }) => {
  await mockDashboard(page, true)
  await page.goto(`${dashboardURL}/dashboard/transactions`)
  await expect(page.getByText('No transactions yet')).toBeVisible()
})
