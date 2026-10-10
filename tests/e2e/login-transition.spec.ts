import { expect, test } from '@playwright/test'
import { mockDashboard } from '../fixtures/dashboard'

test('a signed-in visitor reaches the dashboard without refreshing', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mockDashboard(page)
  await page.goto('http://127.0.0.1:4174/sign-in')
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(
    page.getByRole('region', { name: 'Connected clients' }),
  ).toBeVisible()
  expect(errors).toEqual([])
})

test('Google login finishes its callback before opening the dashboard', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await mockDashboard(page)
  await page.goto(
    'http://127.0.0.1:4174/sign-in?signed-out&privy_oauth_code=test&privy_oauth_state=test&privy_oauth_provider=google',
  )
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('status')).toHaveText('Opening your dashboard')
  expect(new URL(page.url()).pathname).toBe('/sign-in')
  await page.evaluate(() =>
    window.dispatchEvent(new Event('test:oauth-complete')),
  )
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(
    page.getByRole('region', { name: 'Connected clients' }),
  ).toBeVisible()
  await expect(
    page.getByText('Opening your dashboard', { exact: true }),
  ).toHaveCount(0)
  expect(errors).toEqual([])
})
