import type { Page } from '@playwright/test'
import type {
  McpClient,
  ToolActivityItem,
  TransactionActivityItem,
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

const signature =
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi8nXv2Tq1ZsVhUuYc6mRkQ3d5yW7oE2pBtGxHnLfAaJe9'
const recipient = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const other = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const minute = 60_000
const swap: TransactionActivityItem = {
  kind: 'agent',
  id: 'swap-confirmed',
  tool: 'jupiter_swap',
  delivery: 'embedded',
  status: 'confirmed',
  network: 'devnet',
  clientId: client.clientId,
  clientName: client.clientName,
  connected: true,
  review: {
    title: 'Swap USDC for SOL',
    description: 'Swap through Jupiter.',
    actionLabel: 'Swap',
    fields: [
      { label: 'You pay', value: '1 USDC' },
      { label: 'Estimated receive', value: '0.0062 SOL' },
      { label: 'Minimum receive', value: '0.00617 SOL' },
      { label: 'Maximum slippage', value: '0.5%' },
    ],
  },
  account: walletAddress,
  counterparty: null,
  signature,
  receipt: { signature, slot: '454798245', commitment: 'finalized' },
  reviewUrl: null,
  reason: null,
  createdAt: Date.now() - 2 * minute,
  expiresAt: Date.now() + 13 * minute,
}
/** A mixed day of agent transactions, a deposit and withdrawals. */
export const transactions: TransactionActivityItem[] = [
  swap,
  {
    kind: 'deposit',
    id: 'deposit-usdc',
    status: 'confirmed',
    network: 'devnet',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'USDC',
    decimals: 6,
    amountAtomic: '25000000',
    counterparty: other,
    signature: signature.replace('4vJ9', '2Qm8'),
    slot: '454797102',
    createdAt: Date.now() - 5 * minute,
  },
  {
    ...swap,
    id: 'send-open',
    tool: 'solana_transfer',
    delivery: 'link',
    status: 'open',
    review: {
      title: 'Send SOL',
      description: 'Send SOL to the recipient below.',
      actionLabel: 'Send SOL',
      fields: [
        { label: 'Amount', value: '0.05 SOL' },
        { label: 'Recipient', value: recipient },
      ],
    },
    account: null,
    counterparty: recipient,
    signature: null,
    receipt: null,
    reviewUrl: 'http://127.0.0.1:4174/tx/send-open',
    createdAt: Date.now() - 9 * minute,
  },
  {
    ...swap,
    id: 'swap-ready',
    delivery: 'local',
    status: 'ready',
    account: other,
    signature: null,
    receipt: null,
    createdAt: Date.now() - 14 * minute,
  },
  {
    kind: 'withdrawal',
    id: 'withdrawal-usdc',
    status: 'confirmed',
    network: 'devnet',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: 'USDC',
    decimals: 6,
    amountAtomic: '10000000',
    counterparty: other,
    signature,
    slot: '454790011',
    createdAt: Date.now() - 20 * minute,
  },
  {
    ...swap,
    id: 'swap-failed',
    status: 'failed',
    receipt: null,
    reason: 'chain_failed',
    createdAt: Date.now() - 30 * minute,
  },
  {
    ...swap,
    id: 'send-expired',
    tool: 'solana_transfer',
    delivery: 'link',
    status: 'expired',
    review: {
      title: 'Send SOL',
      description: 'Send SOL to the recipient below.',
      actionLabel: 'Send SOL',
      fields: [
        { label: 'Amount', value: '0.2 SOL' },
        { label: 'Recipient', value: recipient },
      ],
    },
    account: null,
    counterparty: recipient,
    signature: null,
    receipt: null,
    createdAt: Date.now() - 26 * 60 * minute,
    expiresAt: Date.now() - 25 * 60 * minute,
  },
  {
    kind: 'withdrawal',
    id: 'withdrawal-sol',
    status: 'pending',
    network: 'devnet',
    mint: 'native',
    symbol: 'SOL',
    decimals: 9,
    amountAtomic: '500000000',
    counterparty: other,
    signature: signature.replace('4vJ9', '3Rn7'),
    slot: null,
    createdAt: Date.now() - 27 * 60 * minute,
  },
]

export async function mockDashboard(page: Page, empty = false) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/wallet/balances': {
        network: 'devnet',
        sol: '100000000',
        usdc: '123456789000',
        tokens: [
          {
            account: 'test-usdc',
            mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
            program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            amount: '123456789000',
            decimals: 6,
            name: 'USD Coin',
            symbol: 'USDC',
            image: null,
          },
        ],
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
      '/api/transactions': {
        items: empty ? [] : transactions,
        nextCursor: null,
        counts: empty
          ? { pending: 0, confirmed: 0, failed: 0, expired: 0 }
          : { pending: 3, confirmed: 3, failed: 1, expired: 1 },
      },
    }
    if (
      path === '/api/transactions/sync' &&
      route.request().method() === 'POST'
    ) {
      await route.fulfill({ json: { inserted: 0, settled: 0 } })
      return
    }
    const one = /^\/api\/transactions\/([^/]+)$/.exec(path)?.[1]
    const found = one && transactions.find((t) => t.id === one)
    if (found && route.request().method() === 'GET') {
      await route.fulfill({ json: found })
      return
    }
    if (route.request().method() !== 'GET' || !(path in responses)) {
      await route.abort()
      return
    }
    await route.fulfill({ json: responses[path] })
  })
}
