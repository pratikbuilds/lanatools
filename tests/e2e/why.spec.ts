import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  test(`why drawing moves between today and lanatools at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: Array<string> = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    const today = page.getByRole('button', { name: 'today', exact: true })
    const after = page.getByRole('button', {
      name: 'with lanatools',
      exact: true,
    })
    await today.scrollIntoViewIfNeeded()
    await expect(today).toHaveAttribute('aria-pressed', 'true')
    await after.click()
    await expect(after).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: test.info().outputPath('why-after.png') })
    await today.click()
    await expect(today).toHaveAttribute('aria-pressed', 'true')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    expect(errors).toEqual([])
  })
}
