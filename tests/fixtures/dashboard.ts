import type { Page } from '@playwright/test'
import type {
  McpClient,
  ToolActivityItem,
} from '../../packages/contracts/src/index'

export const walletAddress = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
export const client: McpClient = {
  grantId: 'test-grant',
  clientId: 'test-client',
  clientName: 'Research assistant with a long name',
  redirectHost: 'desktop.example.com',
  scopes: ['payments:pay', 'helius:read'],
  connectedAt: Date.now(),
  lastUsedAt: Date.now(),
  limitMicroUsd: 1_000_000_000,
  spentMicroUsd: 123_450_000,
  reservedMicroUsd: 0,
  estimatedCredits: 12345,
}
const item: ToolActivityItem = {
  id: 'test-call',
  kind: 'tool',
  clientId: client.clientId,
  clientName: client.clientName,
  connected: true,
  network: 'devnet',
  reason: null,
  createdAt: Date.now(),
  tool: 'helius_getAssetsByOwner',
  provider: 'helius',
  outcome: 'ok',
  estimatedCredits: 100,
  durationMs: 42,
}

export async function mockDashboard(page: Page, empty = false) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/wallet/balances': {
        network: 'devnet',
        sol: '100000000',
        usdc: '123456789000',
      },
      '/api/mcp/clients': { clients: empty ? [] : [client] },
      '/api/payments/signer': { status: 'enabled', walletAddress },
      '/api/activity': {
        items: empty ? [] : [item],
        nextCursor: null,
        totals: {
          calls: 12345,
          spentMicroUsd: 123450000,
          estimatedCredits: 12345,
        },
      },
      '/api/activity/days': { days: [] },
    }
    if (route.request().method() !== 'GET' || !(path in responses)) {
      await route.abort()
      return
    }
    await route.fulfill({ json: responses[path] })
  })
}
