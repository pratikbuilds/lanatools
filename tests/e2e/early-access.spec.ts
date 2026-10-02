import { expect, test } from '@playwright/test'

const formName = 'Join the early access list'
const inputName = 'Email address'
const joinedText = 'You’re on the list.'

test('a saved signup confirms both forms and a reload safely deduplicates', async ({
  page,
}) => {
  const email = `browser-${crypto.randomUUID()}@example.com`
  await page.goto('/')
  const form = page.getByRole('form', { name: formName }).first()
  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(form.getByRole('alert')).toHaveText(
    'Enter your email to join the list.',
  )
  await form.getByRole('textbox', { name: inputName }).fill('nope@')
  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(form.getByRole('alert')).toHaveText(
    'That email doesn’t look right. Check it and try again.',
  )
  await form
    .getByRole('textbox', { name: inputName })
    .fill(`  ${email.toUpperCase()}  `)
  const saved = page.waitForResponse('**/api/early-access')
  await form.getByRole('button', { name: 'Get early access' }).click()
  expect(await (await saved).json()).toEqual({ status: 'saved', email })
  await expect(page.getByText(joinedText)).toHaveCount(2)
  await expect(page.getByText(email).first()).toBeVisible()

  await page.reload()
  await expect(page.getByRole('form', { name: formName })).toHaveCount(2)
  await form.getByRole('textbox', { name: inputName }).fill(email)
  const duplicate = page.waitForResponse('**/api/early-access')
  await form.getByRole('button', { name: 'Get early access' }).click()
  expect(await (await duplicate).json()).toEqual({
    status: 'already-present',
    email,
  })
  await expect(page.getByText(joinedText)).toHaveCount(2)
  await page
    .getByRole('button', { name: 'Use a different email' })
    .first()
    .click()
  await expect(page.getByRole('form', { name: formName })).toHaveCount(2)
  await expect(
    page.getByRole('textbox', { name: inputName }).first(),
  ).toHaveValue('')
})

test('pending submissions disable both forms and a failure preserves the email for retry', async ({
  page,
}) => {
  const email = `retry-${crypto.randomUUID()}@example.com`
  await page.goto('/')
  const form = page.getByRole('form', { name: formName }).first()
  await form.getByRole('textbox', { name: inputName }).fill(email)
  let fail: () => Promise<void> = async () => {
    throw new Error('Request has not started')
  }
  await page.route(
    '**/api/early-access',
    (route) => {
      fail = () =>
        route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    },
    { times: 1 },
  )
  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(page.getByRole('button', { name: 'Joining' })).toHaveCount(2)
  for (const field of await page
    .getByRole('textbox', { name: inputName })
    .all())
    await expect(field).toBeDisabled()
  await expect(page.getByText(joinedText)).toHaveCount(0)
  await fail()
  await expect(form.getByRole('alert')).toHaveText(
    'We couldn’t add you just now. Try again.',
  )
  await expect(form.getByRole('textbox', { name: inputName })).toHaveValue(
    email,
  )
  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(page.getByText(joinedText)).toHaveCount(2)
})

test('old browser-only signup flags do not claim a saved email', async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem('lanatools:early-access', 'never-saved@example.com'),
  )
  await page.goto('/')
  await expect(page.getByText(joinedText)).toHaveCount(0)
  await expect(page.getByRole('form', { name: formName })).toHaveCount(2)
})

test('mobile signup confirms the persisted email', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const form = page.getByRole('form', { name: formName }).first()
  const email = `mobile-${crypto.randomUUID()}@example.com`
  await form.getByRole('textbox', { name: inputName }).fill(email)
  await form.getByRole('button', { name: 'Get early access' }).click()
  await expect(page.getByText(joinedText)).toHaveCount(2)
  await expect(page.getByText(email).first()).toBeVisible()
  await page
    .getByRole('status')
    .first()
    .screenshot({ path: 'test-results/early-access-mobile.png' })
})
