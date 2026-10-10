import { expect, test } from '@playwright/test'
import type { TransactionLink } from '../../packages/contracts/src/index'

const link: TransactionLink = {
  id: 'startup-test',
  tool: 'solana_transfer',
  network: 'devnet',
  review: {
    title: 'Send SOL',
    description: 'Send SOL to the recipient below.',
    actionLabel: 'Send SOL',
    fields: [{ label: 'Amount', value: '0.01 SOL' }],
  },
  status: 'open',
  account: null,
  signature: null,
  receipt: null,
  createdAt: 1_790_000_000_000,
  expiresAt: 1_900_000_000_000,
}

// The HTML holds the prerendered landing page for every path. An app page
// must cover it with its boot screen before any script loads, and preload
// its own chunks so the page is not three round trips away.
const pages = [
  {
    path: '/tx/startup-test',
    boot: 'Opening transaction',
    bar: 'Public transaction link',
    chunk: /\/assets\/tx\._linkId-/,
    ready: () => ({ role: 'heading' as const, name: 'Send SOL' }),
  },
  {
    path: '/sign-in',
    boot: 'Preparing sign-in',
    bar: 'Securing access',
    chunk: /\/assets\/sign-in-/,
    ready: () => ({
      role: 'heading' as const,
      name: 'Sign in to your workspace.',
    }),
  },
  ...['activity', 'settings'].map((child) => ({
    path: `/dashboard/${child}`,
    boot: 'Opening your dashboard',
    bar: 'Checking your account',
    chunk: new RegExp(`/assets/${child}-`),
    ready: () => ({
      role: 'heading' as const,
      name: 'Sign in to your workspace.',
    }),
  })),
]

for (const page of pages) {
  test(`${page.path} boots onto the app, never the landing page`, async ({
    page: tab,
  }) => {
    const errors: Array<string> = []
    const requests: Array<string> = []
    tab.on('pageerror', (error) => errors.push(error.message))
    tab.on('request', (request) => requests.push(request.url()))
    await tab.route('**/api/transaction-links/startup-test', (route) =>
      route.fulfill({ json: link }),
    )
    let resume = () => {}
    const scripts = new Promise<void>((resolve) => {
      resume = resolve
    })
    await tab.route(/\.js(?:\?.*)?$/, async (route) => {
      await scripts
      await route.continue()
    })

    try {
      await tab.goto(page.path, { waitUntil: 'commit' })
      // Before any module script: the boot screen, not the landing page.
      await expect(tab.getByRole('status')).toHaveText(page.boot)
      await expect(tab.getByText(page.bar)).toBeVisible()
      await expect(tab.getByRole('heading', { level: 1 })).toHaveCount(0)
      await expect(tab.getByText('Give your agents')).toHaveCount(0)
      const preloaded = await tab.$$eval('link[rel="modulepreload"]', (links) =>
        links.map((element) => element.getAttribute('href') ?? ''),
      )
      expect(preloaded.some((href) => page.chunk.test(href))).toBe(true)
      expect(preloaded.some((href) => /\/assets\/app-/.test(href))).toBe(true)
      expect(
        preloaded.some((href) => /\/assets\/page-[\w-]{8}\.js/.test(href)),
      ).toBe(false)
      await tab.screenshot({
        path: test.info().outputPath('boot-before-js.png'),
      })

      resume()
      await expect(tab.getByRole(page.ready().role, page.ready())).toBeVisible()
      expect(
        requests.filter((url) => /\/assets\/page-[\w-]{8}\.js/.test(url)),
      ).toEqual([])
      expect(errors).toEqual([])
    } finally {
      resume()
    }
  })
}
