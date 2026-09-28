import { expect, test } from '@playwright/test'

test('joining early access confirms the email everywhere and survives a reload', async ({
  page,
}) => {
  await page.goto('/')
  const form = page
    .getByRole('form', { name: 'Join the early access list' })
    .first()

  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(page.getByRole('alert').first()).toHaveText(
    'Enter your email to join the list.',
  )

  await form.getByRole('textbox', { name: 'Email address' }).fill('nope@')
  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(page.getByRole('alert').first()).toHaveText(
    'That email doesn’t look right. Check it and try again.',
  )

  await form
    .getByRole('textbox', { name: 'Email address' })
    .fill('agent@example.com')
  await form.getByRole('button', { name: 'Get early access' }).click()

  const joined = page.getByText('You’re on the list.')
  await expect(joined).toHaveCount(2)
  await expect(page.getByText('agent@example.com').first()).toBeVisible()

  await page.reload()
  await expect(joined).toHaveCount(2)

  await page
    .getByRole('button', { name: 'Use a different email' })
    .first()
    .click()
  await expect(
    page.getByRole('form', { name: 'Join the early access list' }),
  ).toHaveCount(2)
})
