import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { TransactionLink } from '../../packages/contracts/src/index'

const link: TransactionLink = {
  id: 'public-review-test',
  tool: 'solana_transfer',
  network: 'devnet',
  review: {
    title: 'Send SOL',
    description: 'Send SOL to the recipient below.',
    actionLabel: 'Send SOL',
    fields: [
      { label: 'Amount', value: '0.01 SOL' },
      { label: 'Recipient', value: '11111111111111111111111111111111' },
    ],
  },
  status: 'open',
  account: null,
  signature: null,
  receipt: null,
  createdAt: 1_790_000_000_000,
  expiresAt: 1_900_000_000_000,
}

test('public review needs no login and only reads transaction metadata', async ({
  page,
}) => {
  const requests: Array<{ url: string; method: string }> = []
  const errors: string[] = []
  page.on('request', (request) =>
    requests.push({ url: request.url(), method: request.method() }),
  )
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  await page.goto('/tx/public-review-test')

  await expect(page.getByRole('heading', { name: 'Send SOL' })).toBeVisible()
  await expect(page.getByText('0.01 SOL', { exact: true })).toBeVisible()
  await expect(
    page.getByText('11111111111111111111111111111111', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Solana devnet · Test funds')).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Connect your wallet')
  await expect(page.getByRole('status')).toContainText(
    'Choose the wallet you want to use',
  )
  await page.getByRole('button', { name: 'Refresh status' }).click()
  await expect(
    page.getByRole('button', { name: 'Refresh status' }),
  ).toBeEnabled()
  await expect(page).toHaveURL(/\/tx\/public-review-test$/)

  expect(
    requests.filter(({ url }) =>
      /privy\.io|\/api\/(?:payments|wallet|mcp)/.test(url),
    ),
  ).toEqual([])
  const linkRequests = requests.filter(({ url }) =>
    url.includes('/api/transaction-links/'),
  )
  expect(linkRequests.length).toBeGreaterThanOrEqual(2)
  expect(
    linkRequests.every(
      ({ method, url }) =>
        method === 'GET' &&
        url.endsWith('/api/transaction-links/public-review-test'),
    ),
  ).toBe(true)
  expect(errors).toEqual([])
})

for (const [status, label] of [
  ['confirmed', 'Transaction confirmed'],
  ['expired', 'Link expired'],
  ['unknown', 'Confirmation pending'],
  ['unavailable', 'Link unavailable'],
] as const) {
  test(`public review shows ${status} without offering another transaction`, async ({
    page,
  }) => {
    const signature =
      status === 'confirmed' || status === 'unknown' ? '4'.repeat(88) : null
    await page.route('**/api/transaction-links/public-review-test', (route) =>
      route.fulfill({ json: { ...link, status, signature } }),
    )
    await page.goto('/tx/public-review-test')
    await expect(page.getByRole('status')).toContainText(label)
    if (signature) {
      await expect(page.getByText(signature, { exact: true })).toHaveCount(0)
      await expect(
        page.getByRole('link', {
          name: 'View on Solana Explorer',
          exact: true,
        }),
      ).toHaveAttribute(
        'href',
        `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
      )
    }
    if (status === 'confirmed')
      await expect(
        page.getByRole('button', { name: 'Refresh status' }),
      ).toHaveCount(0)
    await expect(
      page.getByRole('button', { name: /send|sign|connect/i }),
    ).toHaveCount(0)
  })
}

test('missing links show a useful error and allow retry', async ({ page }) => {
  let missing = true
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill(
      missing ? { status: 404, json: { error: 'not_found' } } : { json: link },
    ),
  )
  await page.goto('/tx/public-review-test')
  await expect(page.getByRole('alert')).toContainText(
    'This transaction link could not be found.',
  )
  missing = false
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Send SOL' })).toBeVisible()
})

test('review fields fit a narrow screen and retain the selected theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('lt-theme', 'dark'))
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({
      json: {
        ...link,
        review: {
          title: 'Review operation',
          description: 'Operation details supplied by the tool.',
          actionLabel: 'Continue',
          fields: [
            { label: 'Destination', value: 'LongDestination'.repeat(12) },
          ],
        },
      },
    }),
  )
  await page.goto('/tx/public-review-test')
  await expect(
    page.getByRole('heading', { name: 'Review operation' }),
  ).toBeVisible()
  await expect(page.locator('.dash')).toHaveAttribute('data-theme', 'dark')
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true)
  await page.getByRole('button', { name: 'Switch to light mode' }).click()
  await expect(page.locator('.dash')).toHaveAttribute('data-theme', 'light')
})

const walletAccount = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'
const unsignedTransaction =
  'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQAAAYqI4910CfGV/VLbLTy6XXLKZwm/HZQSG/N0iAG0D29cAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

async function installWallet(
  page: Page,
  options: { signing?: boolean; rejectConnection?: boolean } = {},
) {
  await page.addInitScript(
    ({ account, options: config }) => {
      const calls: string[] = []
      Object.assign(window, { walletCalls: calls })
      let connected = false
      let rejected = false
      const listeners = new Set<(properties: unknown) => void>()
      const features = [
        'solana:signAndSendTransaction',
        ...(config.signing === false ? [] : ['solana:signTransaction']),
      ]
      const registeredAccount = {
        address: account,
        publicKey: new Uint8Array([
          138, 136, 227, 221, 116, 9, 241, 149, 253, 82, 219, 45, 60, 186, 93,
          114, 202, 103, 9, 191, 29, 148, 18, 27, 243, 116, 136, 1, 180, 15,
          111, 92,
        ]),
        chains: ['solana:devnet', 'solana:mainnet'],
        features,
      }
      const wallet = {
        version: '1.0.0',
        name: 'Test Solana Wallet',
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzE5NDVlMSIvPjwvc3ZnPg==',
        chains: ['solana:devnet', 'solana:mainnet'],
        get accounts() {
          return connected ? [registeredAccount] : []
        },
        features: {
          'standard:connect': {
            version: '1.0.0',
            connect: async () => {
              calls.push('connect')
              if (config.rejectConnection && !rejected) {
                rejected = true
                throw new Error('User rejected connection')
              }
              connected = true
              listeners.forEach((listener) =>
                listener({ accounts: [registeredAccount] }),
              )
              return { accounts: [registeredAccount] }
            },
          },
          'standard:disconnect': {
            version: '1.0.0',
            disconnect: async () => {
              connected = false
              listeners.forEach((listener) => listener({ accounts: [] }))
            },
          },
          'standard:events': {
            version: '1.0.0',
            on: (_event: string, listener: (properties: unknown) => void) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
          },
          ...(config.signing === false
            ? {}
            : {
                'solana:signTransaction': {
                  version: '1.0.0',
                  supportedTransactionVersions: ['legacy', 0],
                  signTransaction: async (
                    ...inputs: Array<{ transaction: Uint8Array }>
                  ) => {
                    calls.push('signTransaction')
                    return inputs.map(({ transaction }) => {
                      const signedTransaction = new Uint8Array(transaction)
                      signedTransaction.fill(1, 1, 65)
                      return { signedTransaction }
                    })
                  },
                },
              }),
          'solana:signAndSendTransaction': {
            version: '1.0.0',
            supportedTransactionVersions: ['legacy', 0],
            signAndSendTransaction: async () => {
              calls.push('signAndSendTransaction')
              throw new Error('Wallet broadcast must never be used')
            },
          },
        },
      }
      const register = (api: { register: (...wallets: unknown[]) => void }) =>
        api.register(wallet)
      window.addEventListener('wallet-standard:app-ready', (event) =>
        register(
          (event as CustomEvent<{ register: (...wallets: unknown[]) => void }>)
            .detail,
        ),
      )
      window.dispatchEvent(
        new CustomEvent('wallet-standard:register-wallet', {
          detail: register,
        }),
      )
    },
    { account: walletAccount, options },
  )
}

async function mockPreparation(page: Page, review = link.review) {
  await page.route(
    '**/api/transaction-links/public-review-test/transaction',
    (route) =>
      route.fulfill({
        json: {
          transaction: unsignedTransaction,
          account: walletAccount,
          network: 'devnet',
          review,
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: '1234',
        },
      }),
  )
}

async function walletCalls(page: Page) {
  return page.evaluate(() =>
    'walletCalls' in window ? window.walletCalls : [],
  )
}

test('picker offers Phantom and Solflare without an installed wallet', async ({
  page,
}) => {
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url())
  })
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  await page.goto('/tx/public-review-test')
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Connect your wallet' })
  const phantom = dialog.getByRole('link', { name: /Phantom/ })
  await expect(phantom).toHaveAttribute('href', 'https://phantom.app')
  await expect(phantom).toContainText('Not detected in this browser')
  await expect(phantom).toContainText('Install')
  await expect(
    dialog.getByRole('button', { name: /Solflare.*Connect/ }),
  ).toBeEnabled()
  await expect(
    dialog.getByText(
      'Other installed Solana wallets appear here automatically.',
    ),
  ).toBeVisible()
  await expect(
    dialog.getByText('Test Solana Wallet', { exact: true }),
  ).toHaveCount(0)
  expect(posts).toEqual([])
})

test('custom picker contains keyboard focus and connection does not start transaction expiry', async ({
  page,
}) => {
  await installWallet(page)
  await mockPreparation(page)
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url())
  })
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  await page.goto('/tx/public-review-test')
  const connect = page.getByRole('button', {
    name: 'Connect wallet',
    exact: true,
  })
  await connect.click()
  const dialog = page.getByRole('dialog', { name: 'Connect your wallet' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('LANATOOLS / SOLANA')).toBeVisible()
  await expect(dialog.getByText('Phantom', { exact: true })).toHaveCount(1)
  await expect(dialog.getByText('Solflare', { exact: true })).toHaveCount(1)
  await expect(
    dialog.getByRole('button', { name: /Test Solana Wallet/ }),
  ).toBeEnabled()
  for (let index = 0; index < 5; index++) {
    await page.keyboard.press('Tab')
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(connect).toBeFocused()
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await connect.click()
  await dialog.getByRole('button', { name: /Test Solana Wallet/ }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign & send' })).toBeEnabled()
  expect(await walletCalls(page)).toEqual(['connect'])
  expect(posts).toEqual([])
})

test('signs only after exact review and retries identical signed bytes through the backend', async ({
  page,
}) => {
  await installWallet(page)
  const submissions: string[] = []
  let preparedCount = 0
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  await page.route(
    '**/api/transaction-links/public-review-test/transaction',
    (route) => {
      preparedCount++
      expect(route.request().postDataJSON()).toEqual({ account: walletAccount })
      return route.fulfill({
        json: {
          transaction: unsignedTransaction,
          account: walletAccount,
          network: 'devnet',
          review: {
            ...link.review,
            fields: [{ label: 'Exact amount', value: '0.010000001 SOL' }],
          },
          blockhash: '11111111111111111111111111111111',
          lastValidBlockHeight: '1234',
        },
      })
    },
  )
  await page.route(
    '**/api/transaction-links/public-review-test/send',
    (route) => {
      submissions.push(route.request().postDataJSON().transaction)
      return submissions.length === 1
        ? route.abort('failed')
        : route.fulfill({
            json: {
              ...link,
              status: 'confirmed',
              account: walletAccount,
              signature: 'recorded-signature',
              receipt: {
                signature: 'recorded-signature',
                slot: '123',
                commitment: 'confirmed',
              },
            },
          })
    },
  )
  await page.goto('/tx/public-review-test')
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click()
  await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
  expect(preparedCount).toBe(0)
  expect(await walletCalls(page)).toEqual(['connect'])
  await page.getByRole('button', { name: 'Sign & send' }).click()
  await expect(page.getByText('0.010000001 SOL', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Retry same transaction' }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Retry same transaction' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Transaction confirmed' }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://explorer.solana.com/tx/recorded-signature?cluster=devnet',
  )
  expect(preparedCount).toBe(1)
  expect(submissions).toHaveLength(2)
  expect(submissions[0]).toBe(submissions[1])
  expect(submissions[0]).not.toBe(unsignedTransaction)
  expect(await walletCalls(page)).toEqual(['connect', 'signTransaction'])
})

test('unsupported sign-only capability prevents preparation', async ({
  page,
}) => {
  await installWallet(page, { signing: false })
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url())
  })
  await page.goto('/tx/public-review-test')
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click()
  await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
  await expect(page.getByRole('alert')).toContainText(
    'cannot sign without sending',
  )
  await expect(page.getByRole('button', { name: 'Sign & send' })).toHaveCount(0)
  expect(posts).toEqual([])
})

test('wallet picker handles rejection and fits both themes on narrow screens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await installWallet(page, { rejectConnection: true })
  await mockPreparation(page)
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  await page.goto('/tx/public-review-test')
  for (const theme of ['light', 'dark']) {
    await page
      .getByRole('button', { name: 'Connect wallet', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Connect your wallet' })
    await expect(dialog).toBeVisible()
    expect(
      await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.height <= innerHeight
        )
      }),
    ).toBe(true)
    if (theme === 'light') {
      await dialog.getByRole('button', { name: /Test Solana Wallet/ }).click()
      await expect(dialog.getByRole('alert')).toContainText(
        'Connection was cancelled or unavailable',
      )
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    } else {
      await dialog.getByRole('button', { name: /Test Solana Wallet/ }).click()
      await expect(dialog).not.toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Sign & send' }),
      ).toBeEnabled()
    }
  }
  expect(await walletCalls(page)).toEqual(['connect', 'connect'])
})

test('transaction loading failure can be retried without a request loop', async ({
  page,
}) => {
  await installWallet(page)
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({ json: link }),
  )
  let attempts = 0
  await page.route(
    '**/api/transaction-links/public-review-test/transaction',
    (route) => {
      attempts++
      return route.fulfill({
        status: 503,
        json: {
          error: { message: 'Temporarily unavailable', retryable: true },
        },
      })
    },
  )
  await page.goto('/tx/public-review-test')
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click()
  await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
  expect(attempts).toBe(0)
  await page.getByRole('button', { name: 'Sign & send' }).click()
  await expect(page.getByRole('alert')).toContainText('Temporarily unavailable')
  await expect(
    page.getByRole('button', { name: 'Sign & send', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: 'Refresh status' }).click()
  await expect(
    page.getByRole('button', { name: 'Refresh status' }),
  ).toBeEnabled()
  expect(attempts).toBe(1)
  expect(await walletCalls(page)).toEqual(['connect'])
  await mockPreparation(page)
  await page.route(
    '**/api/transaction-links/public-review-test/send',
    (route) =>
      route.fulfill({
        json: { ...link, status: 'confirmed', signature: 'saved-signature' },
      }),
  )
  await page.getByRole('button', { name: 'Sign & send', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Transaction confirmed' }),
  ).toBeVisible()
  expect(await walletCalls(page)).toEqual(['connect', 'signTransaction'])
})

for (const network of ['devnet', 'mainnet'] as const) {
  test(`receipt links to the ${network} explorer`, async ({ page }) => {
    await page.route('**/api/transaction-links/public-review-test', (route) =>
      route.fulfill({
        json: {
          ...link,
          status: 'confirmed',
          network,
          signature: '4'.repeat(88),
        },
      }),
    )
    await page.goto('/tx/public-review-test')
    await expect(
      page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
    ).toHaveAttribute(
      'href',
      `https://explorer.solana.com/tx/${'4'.repeat(88)}${network === 'devnet' ? '?cluster=devnet' : ''}`,
    )
  })
}

test('lost submission response recovers the saved signature without signing again', async ({
  page,
}) => {
  await installWallet(page)
  await mockPreparation(page)
  let submitted = false
  let sends = 0
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    route.fulfill({
      json: submitted
        ? {
            ...link,
            status: 'confirmed',
            account: walletAccount,
            signature: 'saved-signature',
          }
        : link,
    }),
  )
  await page.route(
    '**/api/transaction-links/public-review-test/send',
    (route) => {
      submitted = true
      sends++
      return route.abort('failed')
    },
  )
  await page.goto('/tx/public-review-test')
  await page
    .getByRole('button', { name: 'Connect wallet', exact: true })
    .click()
  await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
  await page.getByRole('button', { name: 'Sign & send' }).click()
  await expect(
    page.getByRole('heading', { name: 'Transaction confirmed', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'Retry same transaction' }),
  ).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(sends).toBe(1)
  expect(await walletCalls(page)).toEqual(['connect', 'signTransaction'])
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Transaction confirmed', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /connect|sign|retry/i }),
  ).toHaveCount(0)
  expect(sends).toBe(1)
})

test('reloaded pending signature checks status automatically without preparing or sending', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let reads = 0
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url())
  })
  await page.route('**/api/transaction-links/public-review-test', (route) => {
    reads++
    return route.fulfill({
      json: {
        ...link,
        signature: 'saved-signature',
        status: reads > 1 ? 'confirmed' : 'unknown',
      },
    })
  })
  await page.goto('/tx/public-review-test')
  await expect(page.getByRole('status')).toContainText('Confirmation pending')
  await expect(page.getByRole('status')).toContainText(
    'You do not need to connect or sign again',
  )
  await expect(
    page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  await expect(page.getByRole('status')).toContainText(
    'Transaction confirmed',
    { timeout: 10_000 },
  )
  await expect(
    page.getByRole('button', { name: /connect|sign|retry/i }),
  ).toHaveCount(0)
  expect(posts).toEqual([])
})

test('a failed status check retains the saved signature and last known state', async ({
  page,
}) => {
  let fail = false
  await page.route('**/api/transaction-links/public-review-test', (route) =>
    fail
      ? route.abort('failed')
      : route.fulfill({
          json: { ...link, status: 'unknown', signature: 'saved-signature' },
        }),
  )
  await page.goto('/tx/public-review-test')
  await expect(page.getByRole('status')).toContainText('Confirmation pending')
  fail = true
  await page.getByRole('button', { name: 'Refresh status' }).click()
  await expect(page.getByRole('alert')).toContainText('last known result')
  await expect(
    page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Confirmation pending')
  await expect(
    page.getByRole('button', { name: /connect|sign|retry/i }),
  ).toHaveCount(0)
})

for (const operation of [
  {
    tool: 'record_note',
    title: 'Record note',
    fields: [{ label: 'Message', value: 'Hello Solana' }],
  },
  {
    tool: 'record_ballot',
    title: 'Record ballot',
    fields: [
      { label: 'Proposal', value: 'Community garden' },
      { label: 'Choice', value: 'Yes' },
    ],
  },
]) {
  test(`shared page reviews and signs ${operation.tool} without SOL-specific fields`, async ({
    page,
  }) => {
    const review = {
      title: operation.title,
      description: 'Review this operation.',
      actionLabel: 'Record',
      fields: operation.fields,
    }
    await installWallet(page)
    await mockPreparation(page, review)
    await page.route('**/api/transaction-links/public-review-test', (route) =>
      route.fulfill({ json: { ...link, tool: operation.tool, review } }),
    )
    await page.route(
      '**/api/transaction-links/public-review-test/send',
      (route) =>
        route.fulfill({
          json: {
            ...link,
            tool: operation.tool,
            review,
            status: 'confirmed',
            signature: 'operation-signature',
          },
        }),
    )
    await page.goto('/tx/public-review-test')
    await expect(
      page.getByRole('heading', { name: operation.title }),
    ).toBeVisible()
    for (const field of operation.fields)
      await expect(page.getByText(field.value, { exact: true })).toBeVisible()
    await expect(page.getByText('Amount', { exact: true })).toHaveCount(0)
    await expect(page.getByText('Recipient', { exact: true })).toHaveCount(0)
    await page
      .getByRole('button', { name: 'Connect wallet', exact: true })
      .click()
    await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
    await page.getByRole('button', { name: 'Sign & send' }).click()
    await expect(
      page.getByRole('heading', { name: 'Transaction confirmed', exact: true }),
    ).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
    ).toBeVisible()
    expect(await walletCalls(page)).toEqual(['connect', 'signTransaction'])
  })
}

test('a delayed status read cannot replace a confirmed submission', async ({
  page,
}) => {
  await installWallet(page)
  await mockPreparation(page)
  let holdRead = false
  let releaseRead = () => {}
  let finishRead = () => {}
  const held = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const finished = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  await page.route(
    '**/api/transaction-links/public-review-test',
    async (route) => {
      if (holdRead) {
        await held
        await route.fulfill({ json: link })
        finishRead()
      } else await route.fulfill({ json: link })
    },
  )
  await page.route(
    '**/api/transaction-links/public-review-test/send',
    (route) =>
      route.fulfill({
        json: { ...link, status: 'confirmed', signature: 'saved-signature' },
      }),
  )
  try {
    await page.goto('/tx/public-review-test')
    await page
      .getByRole('button', { name: 'Connect wallet', exact: true })
      .click()
    await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
    await expect(
      page.getByRole('button', { name: 'Sign & send' }),
    ).toBeEnabled()
    holdRead = true
    await page.getByRole('button', { name: 'Refresh status' }).click()
    await expect(
      page.getByRole('button', { name: 'Refreshing…' }),
    ).toBeDisabled()
    await page.getByRole('button', { name: 'Sign & send' }).click()
    await expect(
      page.getByRole('heading', { name: 'Transaction confirmed' }),
    ).toBeVisible()
    releaseRead()
    await finished
    await expect(
      page.getByRole('heading', { name: 'Transaction confirmed' }),
    ).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'View on Solana Explorer', exact: true }),
    ).toBeVisible()
  } finally {
    releaseRead()
  }
})

for (const rejection of ['transaction_expired', 'invalid_input'] as const) {
  test(`${rejection} signing bytes can be renewed within the same unexpired link`, async ({
    page,
  }) => {
    await installWallet(page)
    const expiresAt = Date.now() + 10 * 60_000
    let signingExpired = false
    let builds = 0
    const submissions: string[] = []
    const renewedBytes = Buffer.from(unsignedTransaction, 'base64')
    renewedBytes[renewedBytes.length - 3] = 1
    await page.route('**/api/transaction-links/public-review-test', (route) =>
      route.fulfill({
        json: {
          ...link,
          expiresAt,
          account: walletAccount,
          status: signingExpired ? 'transaction_expired' : 'ready',
        },
      }),
    )
    await page.route(
      '**/api/transaction-links/public-review-test/transaction',
      (route) => {
        builds++
        return route.fulfill({
          json: {
            transaction:
              builds === 1
                ? unsignedTransaction
                : renewedBytes.toString('base64'),
            account: walletAccount,
            network: 'devnet',
            review: link.review,
            blockhash: '11111111111111111111111111111111',
            lastValidBlockHeight: '1234',
          },
        })
      },
    )
    await page.route(
      '**/api/transaction-links/public-review-test/send',
      (route) => {
        submissions.push(route.request().postDataJSON().transaction)
        if (submissions.length === 1) {
          signingExpired = true
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: rejection,
                message: 'The signing request expired. Sign again to continue.',
                retryable: true,
              },
            },
          })
        }
        return route.fulfill({
          json: {
            ...link,
            expiresAt,
            status: 'confirmed',
            signature: 'renewed-signature',
          },
        })
      },
    )
    await page.goto('/tx/public-review-test')
    await page
      .getByRole('button', { name: 'Connect wallet', exact: true })
      .click()
    await page.getByRole('button', { name: /Test Solana Wallet/ }).click()
    expect(builds).toBe(0)
    await page.getByRole('button', { name: 'Sign & send' }).click()
    await expect(page.getByRole('alert')).toContainText(
      rejection === 'transaction_expired'
        ? 'signing request expired'
        : 'signing request changed',
    )
    await expect(
      page.getByRole('heading', { name: 'Link expired' }),
    ).toHaveCount(0)
    await expect(page.getByText('Link available until')).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Retry same transaction' }),
    ).toHaveCount(0)
    await page.getByRole('button', { name: 'Sign & send' }).click()
    await expect(
      page.getByRole('heading', { name: 'Transaction confirmed' }),
    ).toBeVisible()
    expect(builds).toBe(2)
    expect(submissions).toHaveLength(2)
    expect(submissions[0]).not.toBe(submissions[1])
    expect(await walletCalls(page)).toEqual([
      'connect',
      'signTransaction',
      'signTransaction',
    ])
  })
}
