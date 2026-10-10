import { expect, test } from '@playwright/test'
import { mockDashboard } from '../fixtures/dashboard'

for (const width of [320, 1440]) {
  test(`withdrawal shows token metadata, exact balances and token-specific amounts at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 740 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    await mockDashboard(page)
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    await page.route('**/api/wallet/balances?**', (route) =>
      route.fulfill({
        json: {
          network: 'devnet',
          sol: '100000000',
          usdc: '1250000',
          tokens: [
            {
              account: 'usdc-account',
              mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
              program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              amount: '1250000',
              decimals: 6,
              name: 'USD Coin',
              symbol: 'USDC',
              image: null,
            },
            {
              account: 'other-account',
              mint,
              program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
              amount: '123456789',
              decimals: 9,
              name: 'Example token',
              symbol: 'TEST',
              image: 'https://example.com/token.svg',
            },
            ...Array.from({ length: 30 }, (_, index) => ({
              account: `extra-${index}`,
              mint: `ExampleMint${index}`,
              program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              amount: '123456789',
              decimals: 6,
              name: `Additional token ${index}`,
              symbol: `T${index}`,
              image: null,
            })),
            {
              account: 'unnamed-account',
              mint: '9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N',
              program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              amount: '2',
              decimals: 0,
              name: null,
              symbol: null,
              image: null,
            },
          ],
        },
      }),
    )
    await page.route('https://example.com/token.svg', (route) =>
      route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#5865F2"/></svg>',
      }),
    )
    await page.goto('http://127.0.0.1:4174/dashboard')
    await page.getByRole('button', { name: /Withdraw/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Withdraw', exact: true })
    await expect(dialog.getByText('USD Coin', { exact: true })).toBeVisible()
    const trigger = dialog.getByRole('button', { name: /Choose token/ })
    const address = dialog.getByPlaceholder('Solana address')
    await page.evaluate(() => document.fonts.ready)
    const before = await address.boundingBox()
    await trigger.click()
    const search = dialog.getByRole('searchbox', { name: 'Search tokens' })
    await expect(search).toBeFocused()
    await search.fill('missing-token')
    await expect(dialog.getByRole('status')).toContainText('No tokens found')
    await search.fill('additional token 29')
    await expect(
      dialog.getByRole('button', { name: /Additional token/ }),
    ).toHaveCount(1)
    await search.fill(mint)
    await dialog.getByRole('button', { name: /Example token/ }).click()
    await expect(trigger).toBeFocused()
    expect(await address.boundingBox()).toEqual(before)
    await expect(
      dialog.getByText('0.123456789 TEST available', { exact: true }),
    ).toBeVisible()
    await expect(dialog.getByText(`Mint: ${mint}`)).toBeVisible()
    await expect
      .poll(() =>
        dialog
          .locator('img')
          .evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
          ),
      )
      .toBe(true)
    await dialog.getByRole('button', { name: 'Max', exact: true }).click()
    await expect(dialog.getByPlaceholder('0.00')).toHaveValue('0.123456789')
    await dialog
      .getByPlaceholder('Solana address')
      .fill('9sj4Zv9pYmSbPQ4acY1rPSH6rS1GYxkfQXL3GoXYxK5N')
    await dialog.getByPlaceholder('0.00').fill('0.1234567891')
    await expect(dialog.getByRole('alert')).toContainText('9 decimals')
    await trigger.click()
    await search.fill('9sj4Zv')
    await dialog.getByRole('button', { name: /9sj4Zv…xK5N/ }).click()
    await dialog.getByRole('button', { name: 'Max', exact: true }).click()
    await expect(dialog.getByPlaceholder('0.00')).toHaveValue('2')
    const beforeSol = await address.boundingBox()
    await trigger.click()
    await search.fill('sol')
    await search.press('Tab')
    await page.keyboard.press('Enter')
    await expect(trigger).toContainText('Solana')
    await expect(dialog.getByText('Native SOL · No mint address')).toBeVisible()
    expect(await address.boundingBox()).toEqual(beforeSol)
    await dialog.getByRole('button', { name: 'Max', exact: true }).click()
    await expect(dialog.getByPlaceholder('0.00')).toHaveValue('0.099995')
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true)
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeInViewport()
    await trigger.click()
    await search.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(trigger).toBeFocused()
    await expect(search).toHaveCount(0)
    await trigger.click()
    await dialog.getByRole('heading', { name: 'Withdraw' }).click()
    await expect(search).toHaveCount(0)
    expect(
      await dialog
        .locator('form')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true)
    expect(errors).toEqual([])
  })
}
