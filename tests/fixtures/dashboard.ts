import type { Page } from '@playwright/test'
import type {
  McpClient,
  PhoenixAccount,
  PhoenixCandles,
  PhoenixFills,
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
/** Jupiter and Phoenix transactions that carry their typed trade. */
const trading: TransactionActivityItem[] = [
  {
    ...swap,
    id: 'swap-traded',
    network: 'mainnet',
    review: {
      ...swap.review,
      trade: {
        kind: 'swap',
        venue: 'jupiter',
        pay: {
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          symbol: 'USDC',
          amount: '1',
        },
        receive: {
          mint: 'So11111111111111111111111111111111111111112',
          symbol: 'SOL',
          estimated: '0.00913',
          minimum: '0.00908',
        },
        maxSlippageBps: 50,
      },
    },
    createdAt: Date.now() - 3 * minute,
  },
  {
    ...swap,
    id: 'perp-buy',
    tool: 'phoenix_market_order',
    network: 'mainnet',
    review: {
      title: 'Place a Phoenix market order',
      description:
        'Market buy (long): 0.1 SOL perp now, paying at most $110.15 each',
      actionLabel: 'Place a Phoenix market order',
      fields: [
        {
          label: 'Notice',
          value:
            'This order expires about a minute after it was prepared; after that it is not sent.',
        },
      ],
      trade: {
        kind: 'perp',
        venue: 'phoenix',
        action: 'order',
        symbol: 'SOL',
        side: 'buy',
        orderType: 'market',
        size: '0.1',
        worstPrice: '110.15',
        bestPrice: '109.6',
        notionalUsd: '10.96',
        feeUsd: '0.003836',
        reduceOnly: false,
      },
    },
    createdAt: Date.now() - 4 * minute,
  },
  {
    ...swap,
    id: 'perp-deposit',
    tool: 'phoenix_deposit',
    network: 'mainnet',
    review: {
      title: 'Deposit USDC into Phoenix',
      description: 'Deposit 250 USDC into the Phoenix cross-margin account',
      actionLabel: 'Deposit USDC into Phoenix',
      fields: [],
      trade: {
        kind: 'perp',
        venue: 'phoenix',
        action: 'deposit',
        amountUsdc: '250',
      },
    },
    createdAt: Date.now() - 6 * minute,
  },
]

/** A mixed day of agent transactions, a deposit and withdrawals. */
export const transactions: TransactionActivityItem[] = [
  swap,
  ...trading,
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

/** The embedded wallet's Phoenix account: a SOL long, an ETH short, one order. */
export const phoenixAccount: PhoenixAccount = {
  wallet: walletAddress,
  exists: true,
  accountValueUsd: '1270.85',
  collateralUsdc: '1250',
  unrealizedPnlUsd: '20.85',
  maintenanceMarginUsd: '210.4',
  leverage: '0.89',
  riskState: 'healthy',
  positions: [
    {
      symbol: 'SOL',
      subaccount: 0,
      marginMode: 'cross',
      side: 'long',
      size: '1.6',
      entryPrice: '106.8',
      markPrice: '109.52',
      valueUsd: '175.23',
      unrealizedPnlUsd: '4.35',
      liquidationPrice: '80.4',
      fundingUsdc: '-0.08',
    },
    {
      symbol: 'ETH',
      subaccount: 0,
      marginMode: 'cross',
      side: 'short',
      size: '0.25',
      entryPrice: '2560',
      markPrice: '2504.2',
      valueUsd: '626.05',
      unrealizedPnlUsd: '13.95',
      liquidationPrice: '3270',
      fundingUsdc: '-0.21',
    },
  ],
  orders: [
    {
      symbol: 'ETH',
      subaccount: 0,
      orderId: '81204',
      side: 'sell',
      type: 'limit',
      price: '2590',
      size: '0.5',
      reduceOnly: false,
    },
  ],
}

/** A wallet that never traded on Phoenix. */
export const emptyPhoenixWallet = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'

/** A day of 15-minute candles drifting around `mark`. */
function phoenixCandles(symbol: string, mark: number): PhoenixCandles {
  const end = Math.floor(Date.now() / 900_000) * 900
  const candles = Array.from({ length: 96 }, (_, index) => {
    const close =
      mark * (1 + Math.sin(index / 7) * 0.01 + (index - 95) * 0.0001)
    const open =
      mark * (1 + Math.sin((index - 1) / 7) * 0.01 + (index - 96) * 0.0001)
    return {
      time: end - (95 - index) * 900,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
    }
  })
  return { symbol, range: '1D', candles }
}

export const phoenixFills: PhoenixFills = {
  fills: [
    {
      time: Date.now() - 4 * minute,
      symbol: 'SOL',
      side: 'buy',
      size: '0.1',
      price: '109.6',
      feeUsdc: '0.0038',
      realizedPnlUsdc: '0',
      signature,
      placedBy: client.clientName,
    },
    {
      time: Date.now() - 2 * 24 * 60 * minute,
      symbol: 'ETH',
      side: 'sell',
      size: '0.25',
      price: '2560',
      feeUsdc: '0.32',
      realizedPnlUsdc: '0',
      signature: null,
      placedBy: null,
    },
  ],
  nextCursor: null,
}

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
      await route.fulfill({ json: { inserted: 0, settled: 0, more: false } })
      return
    }
    const phoenix = /^\/api\/phoenix\/(account|candles|fills)\/([^/]+)$/.exec(
      path,
    )
    if (phoenix) {
      const [, kind, key] = phoenix
      const own = key === walletAddress
      await route.fulfill({
        json:
          kind === 'account'
            ? own
              ? phoenixAccount
              : {
                  ...phoenixAccount,
                  wallet: key,
                  exists: false,
                  positions: [],
                  orders: [],
                }
            : kind === 'candles'
              ? phoenixCandles(key ?? 'SOL', key === 'ETH' ? 2504.2 : 109.52)
              : own
                ? phoenixFills
                : { fills: [], nextCursor: null },
      })
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
