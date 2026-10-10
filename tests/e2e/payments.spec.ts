import { expect, test } from '@playwright/test'
import {
  getCatalogEntry,
  listCatalog,
  localCatalog,
  searchCatalog,
} from '../../packages/catalog/src/index'
import { mockDashboard } from '../fixtures/dashboard'

const source = localCatalog()
const url = 'http://127.0.0.1:4174/dashboard/payments'

for (const width of [320, 390, 640, 1440]) {
  test(`browse, search and inspect payment endpoints at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await mockDashboard(page)
    await page.route('**/api/catalog**', async (route) => {
      const request = route.request()
      const parsed = new URL(request.url())
      if (parsed.pathname === '/api/catalog') {
        await route.fulfill({ json: listCatalog(source) })
      } else if (parsed.pathname === '/api/catalog/entry') {
        const entry = await getCatalogEntry(source, fetch, {
          fqn: parsed.searchParams.get('fqn') ?? '',
        })
        await route.fulfill({ json: entry })
      } else {
        const { query, category } = request.postDataJSON()
        if (query === 'rate limit') {
          await route.fulfill({
            status: 429,
            json: { error: 'Request failed' },
          })
          return
        }
        await route.fulfill({
          json: await searchCatalog(
            source,
            { query, category, maxResults: 5 },
            null,
          ),
        })
      }
    })
    await page.goto(url)
    await expect(
      page.getByRole('heading', { name: 'Payments', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByText(`${source.providers.length} providers`, { exact: true }),
    ).toBeVisible()
    const taskInput = page.getByRole('searchbox', {
      name: 'What do you need to do?',
    })
    await taskInput.focus()
    await expect(taskInput).toHaveCSS('outline-style', 'none')
    for (const button of await page
      .getByLabel('Example tasks')
      .getByRole('button')
      .all()) {
      expect(
        await button.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true)
    }
    const region = page.getByRole('region', { name: 'Payment endpoints' })
    const providerList = region.getByRole('list', { name: 'Providers' })
    await providerList.getByRole('button').first().click()
    const preview = region.getByRole('article', { name: 'Provider endpoints' })
    await expect(
      preview.getByRole('button', { name: 'Copy URL' }).first(),
    ).toBeVisible()
    await expect(preview).toContainText('catalog estimates')
    const about = preview.getByText('About this provider', { exact: true })
    await about.click()
    await expect(about.locator('..')).toHaveAttribute('open', '')
    await about.click()
    const endpoints = preview.getByRole('region', { name: 'Endpoints' })
    const endpoint = endpoints.locator('details').first()
    await endpoint.locator('summary').focus()
    await page.keyboard.press('Enter')
    await expect(endpoint).not.toHaveAttribute('open')
    await page.keyboard.press('Enter')
    await expect(endpoint).toHaveAttribute('open', '')
    await page.getByRole('combobox', { name: 'Category' }).selectOption('ai_ml')
    await expect(providerList.getByRole('button')).toHaveCount(
      source.providers.filter((provider) => provider.category === 'ai_ml')
        .length,
    )
    await page
      .getByRole('searchbox', { name: 'What do you need to do?' })
      .fill('image generation')
    await page
      .getByRole('button', { name: 'Find endpoints', exact: true })
      .click()
    await expect(
      page.getByText('Keyword search', { exact: true }),
    ).toBeVisible()
    await expect(region.locator('article').first()).toBeVisible()
    await expect(
      region.getByRole('button', { name: 'Copy URL' }).first(),
    ).toBeVisible()
    await page.evaluate(() => scrollTo(0, 0))
    await expect(endpoints.locator('summary').first()).toBeInViewport()
    const best = (
      await searchCatalog(
        source,
        { query: 'image generation', category: 'ai_ml', maxResults: 5 },
        null,
      )
    ).providers[0]
    if (!best) throw new Error('Image search needs a provider')
    const foreground = await page
      .getByRole('heading', { name: 'Payments', exact: true })
      .evaluate((element) => getComputedStyle(element).color)
    await expect(
      endpoints.getByText(best.endpoints[0]?.path || '/', { exact: true }),
    ).toHaveCSS('color', foreground)
    await preview
      .getByRole('button', { name: `All ${best.endpoint_count} endpoints` })
      .click()
    await expect(endpoints.locator('details')).toHaveCount(
      source.providers.find((provider) => provider.fqn === best.fqn)?.endpoints
        .length ?? 0,
    )
    await preview.getByRole('button', { name: 'Show matches' }).click()
    await expect(endpoints.locator('details')).toHaveCount(
      best.endpoints.length,
    )
    await providerList.getByRole('button').nth(1).click()
    await expect(providerList.getByRole('button').nth(1)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(preview.getByText('Best match', { exact: true })).toHaveCount(
      0,
    )
    await expect(
      page.getByRole('link', { name: 'Payments', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page
      .getByRole('searchbox', { name: 'What do you need to do?' })
      .fill('zzzzunavailableendpointzzzz')
    await page
      .getByRole('button', { name: 'Find endpoints', exact: true })
      .click()
    await expect(
      page.getByRole('heading', { name: 'No matching endpoints' }),
    ).toBeVisible()
    await page
      .getByRole('searchbox', { name: 'What do you need to do?' })
      .fill('rate limit')
    await page
      .getByRole('button', { name: 'Find endpoints', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText('Try again in a minute')
    await page.getByRole('button', { name: 'Browse all' }).click()
    await expect(
      page.getByRole('heading', { name: 'Browse providers' }),
    ).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('the deployed catalog routes require sign-in, including the index', async ({
  request,
}) => {
  for (const path of ['/api/catalog', '/api/catalog/entry?fqn=paysponge/fal']) {
    expect((await request.get(`http://127.0.0.1:3101${path}`)).status()).toBe(
      401,
    )
  }
  expect(
    (
      await request.post('http://127.0.0.1:3101/api/catalog/search', {
        data: { query: 'image' },
      })
    ).status(),
  ).toBe(401)
})
