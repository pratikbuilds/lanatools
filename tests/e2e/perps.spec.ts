import { expect, test } from '@playwright/test'
import {
  emptyPhoenixWallet,
  mockDashboard,
  walletAddress,
} from '../fixtures/dashboard'

// The mocked dashboard's dev server; a scratch config may move it off 4174.
const dashboardURL = process.env.E2E_WEB_URL ?? 'http://127.0.0.1:4174'

for (const width of [390, 1440]) {
  test(`the Phoenix account page charts a position and lists the account at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await mockDashboard(page)

    // The bare path is the user's own wallet.
    await page.goto(`${dashboardURL}/dashboard/perps`)
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/perps/${walletAddress}$`),
    )
    await expect(
      page.getByRole('heading', { name: 'Phoenix account' }),
    ).toBeVisible()
    await expect(page.getByText('Your LanaTools wallet ·')).toBeVisible()
    await expect(page.getByText('$1,270.85')).toBeVisible()
    await expect(page.getByText('0.89×')).toBeVisible()

    // The first position is charted, with its levels in the key.
    const markets = page.getByRole('group', { name: 'Market' })
    await expect(
      markets.getByRole('button', { name: /SOL-PERP/ }),
    ).toHaveAttribute('aria-pressed', 'true')
    const chart = page.getByRole('img', { name: /Price chart/ })
    await expect(chart.locator('canvas').first()).toBeVisible()
    await expect(page.getByText('Entry $106.80')).toBeVisible()
    await expect(page.getByText('Liquidation $80.40')).toBeVisible()
    await expect(page.getByText('Room to liquidation')).toBeVisible()
    await expect(page.getByText('27% below mark')).toBeVisible()

    // The chart zooms with the wheel without breaking the page.
    const box = await chart.boundingBox()
    if (!box) throw new Error('The chart has no size')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -400)
    await page.getByRole('button', { name: 'Show liquidation' }).click()
    await expect(
      page.getByRole('button', { name: 'Hide liquidation' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Reset view' }).click()
    await page.screenshot({
      path: test.info().outputPath('perps.png'),
      fullPage: true,
    })

    // Another market: the short, and its resting order on the chart.
    await markets.getByRole('button', { name: /ETH-PERP/ }).click()
    await expect(page.getByText('Sell limit $2,590.00')).toBeVisible()
    await expect(page.getByText('31% above mark')).toBeVisible()

    // Tables: positions, the order, fills named by client.
    const positions = page.getByRole('region', { name: 'Positions' })
    await expect(positions.getByText('SOL-PERP')).toBeVisible()
    await expect(positions.getByText('+$13.95')).toBeVisible()
    const fills = page.getByRole('region', { name: 'Fills' })
    if (width >= 1024) {
      await expect(
        fills.getByText('Research assistant with a long name'),
      ).toBeVisible()
      await expect(fills.getByText('Outside LanaTools')).toBeVisible()
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width + 1)

    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await expect(chart.locator('canvas').first()).toBeVisible()
    await page.screenshot({
      path: test.info().outputPath('perps-dark.png'),
      fullPage: true,
    })

    // Any address can be viewed.
    await page
      .getByRole('searchbox', { name: 'View another address' })
      .fill(emptyPhoenixWallet)
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/perps/${emptyPhoenixWallet}$`),
    )
    await expect(
      page.getByText('No Phoenix account for this address'),
    ).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('a perp transaction opens its signer’s Phoenix account', async ({
  page,
}) => {
  await mockDashboard(page)
  await page.goto(`${dashboardURL}/dashboard/transactions`)
  await page
    .getByRole('list')
    .first()
    .getByRole('button', { name: /Buy 0\.1 SOL-PERP/ })
    .click()
  await page.getByRole('link', { name: /Open account/ }).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/perps/${walletAddress}$`))
  await expect(page.getByText('$1,270.85')).toBeVisible()
})
