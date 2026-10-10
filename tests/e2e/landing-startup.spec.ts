import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  test(`landing paints before JavaScript and hydrates at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    if (width === 390) await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: Array<string> = []
    const requests: Array<string> = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    page.on('request', (request) => requests.push(request.url()))
    let resume = () => {}
    const scripts = new Promise<void>((resolve) => {
      resume = resolve
    })
    await page.route(/\.js(?:\?.*)?$/, async (route) => {
      await scripts
      await route.continue()
    })

    try {
      await page.goto('/', { waitUntil: 'commit' })
      const heading = page.getByRole('heading', { level: 1 })
      await expect(heading).toHaveText(
        'Connect your agentto everything on Solana.',
      )
      await expect(heading).toBeVisible()
      const original = await heading.elementHandle()
      await expect(
        page.getByRole('link', { name: 'Get started', exact: true }),
      ).toHaveAttribute('href', '/sign-in')
      const form = page.getByRole('form', { name: 'Get updates by email' })
      const input = form.getByRole('textbox', { name: 'Email address' })
      const submit = form.getByRole('button', { name: 'Get updates' })
      await expect(form).toBeVisible()
      await expect(submit).toBeDisabled()
      await input.fill('nope@')
      await input.press('Enter')
      await expect(page).toHaveURL(/\/$/)
      await page.screenshot({
        path: test.info().outputPath('landing-before-js.png'),
      })

      resume()
      await page.waitForLoadState('networkidle')
      expect(await original.evaluate((element) => element.isConnected)).toBe(
        true,
      )
      await expect(input).toHaveValue('nope@')
      await expect(submit).toBeEnabled()
      await submit.click()
      await expect(form.getByRole('alert')).toHaveText(
        'That email doesn’t look right. Check it and try again.',
      )
      expect(
        requests.filter((url) => /\/assets\/app-|privy\.io/.test(url)),
      ).toEqual([])
      expect(errors).toEqual([])
    } finally {
      resume()
    }
  })
}
