import { expect, test } from '@playwright/test'

test('account links open the sign-in page with named wallet options', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('link', { name: 'Create account' }).first().click()

  await expect(page).toHaveURL(/\/sign-in$/)
  await expect(
    page.getByRole('heading', { name: 'Sign in to your workspace.' }),
  ).toBeVisible()
  for (const wallet of ['Phantom', 'Solflare', 'Backpack']) {
    const choice = page.getByRole('button', { name: wallet })
    await expect(choice).toBeVisible()
    expect(
      await choice.locator('img').evaluate((icon) => {
        const image = icon as HTMLImageElement
        return image.complete && image.naturalWidth > 0
      }),
    ).toBe(true)
  }
  await expect(
    page.getByRole('button', { name: 'More Solana wallets' }),
  ).toBeVisible()
})

test('wallet choices stay in view on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/sign-in')

  await expect(
    page.getByRole('button', { name: 'More Solana wallets' }),
  ).toBeInViewport()
})
