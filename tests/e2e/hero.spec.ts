import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  test(`hero toolkit keeps the card fan and original page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: Array<string> = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/')
    const hero = page.getByRole('img', {
      name: /^A toolkit of example agent tasks/,
    })
    await hero.scrollIntoViewIfNeeded()
    await expect(hero.getByText('✓ paid · receipt saved')).toBeVisible()
    await expect(hero.getByText('✓ portfolio returned')).toHaveCSS(
      'opacity',
      '1',
      { timeout: 10000 },
    )
    await page.screenshot({ path: test.info().outputPath('hero-toolkit.png') })
    await expect(hero.getByText('✕ denied · over limit')).toHaveCSS(
      'opacity',
      '1',
      { timeout: 10000 },
    )
    await page.screenshot({ path: test.info().outputPath('hero-denied.png') })
    expect(
      await page
        .locator('main > section[id]')
        .evaluateAll((sections) => sections.map((section) => section.id)),
    ).toEqual(['why', 'how', 'control', 'tools', 'connect'])
    await expect(
      page.getByRole('button', { name: 'Raise limit', exact: true }),
    ).toHaveCount(1)
    await expect(
      page.getByRole('heading', { name: 'Ask for a result, skip the setup' }),
    ).toHaveCount(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload()
    await hero.scrollIntoViewIfNeeded()
    await expect(hero.getByText(/^[✓✕]/)).toHaveCount(0)
    for (const tool of ['pay', 'read', 'track', 'send', 'analyze']) {
      await expect(hero.getByText(tool, { exact: true })).toBeVisible()
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true)
    expect(errors).toEqual([])
  })
}
