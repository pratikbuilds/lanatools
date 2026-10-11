import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import {
  RouterContextProvider,
  createMemoryHistory,
  createRouter,
} from '@tanstack/react-router'
import { routeTree } from '#/routeTree.gen'
import type { TransactionActivityItem } from '@lanatools/contracts'
import { DashboardSessionProvider } from './session'
import { TransactionDetail, TransactionRows } from './transactions'

const now = new Date(2026, 9, 10, 15).getTime()
const WALLET = 'G7fu2vBDEZ9SYM4agJPshffJQUmyg6UCEEUnxuYRAMuq'
const RECIPIENT = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'
const SIGNATURE =
  '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi8nXv2Tq1ZsVhUuYc6mRkQ3d5yW7oE2pBtGxHnLfAaJe9'

const swap: TransactionActivityItem = {
  kind: 'agent',
  id: 'swap-1',
  tool: 'jupiter_swap',
  delivery: 'embedded',
  status: 'confirmed',
  network: 'devnet',
  clientId: 'client-1',
  clientName: 'Codex',
  connected: true,
  review: {
    title: 'Swap USDC for SOL',
    description: 'd',
    actionLabel: 'Swap',
    fields: [
      { label: 'You pay', value: '1 USDC' },
      { label: 'Estimated receive', value: '0.0062 SOL' },
      { label: 'Maximum slippage', value: '0.5%' },
    ],
  },
  account: WALLET,
  counterparty: null,
  signature: SIGNATURE,
  receipt: { signature: SIGNATURE, slot: '454798245', commitment: 'finalized' },
  reviewUrl: null,
  reason: null,
  createdAt: new Date(2026, 9, 10, 14, 31).getTime(),
  expiresAt: new Date(2026, 9, 10, 14, 46).getTime(),
}
const openLink: TransactionActivityItem = {
  ...swap,
  id: 'send-1',
  tool: 'solana_transfer',
  delivery: 'link',
  status: 'open',
  clientName: 'Claude Code',
  review: {
    title: 'Send SOL',
    description: 'd',
    actionLabel: 'Send SOL',
    fields: [
      { label: 'Amount', value: '0.05 SOL' },
      { label: 'Recipient', value: RECIPIENT },
    ],
  },
  account: null,
  counterparty: RECIPIENT,
  signature: null,
  receipt: null,
  reviewUrl: 'http://localhost:5173/tx/send-1',
  createdAt: new Date(2026, 9, 10, 13, 20).getTime(),
}
const failed: TransactionActivityItem = {
  ...swap,
  id: 'swap-2',
  status: 'failed',
  receipt: null,
  reason: 'chain_failed',
  createdAt: new Date(2026, 9, 9, 9, 12).getTime(),
}
const deposit: TransactionActivityItem = {
  kind: 'deposit',
  id: 'dep-1',
  status: 'confirmed',
  network: 'devnet',
  mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  symbol: 'USDC',
  decimals: 6,
  amountAtomic: '25000000',
  counterparty: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  signature: SIGNATURE,
  slot: '454797102',
  createdAt: new Date(2026, 9, 10, 13, 58).getTime(),
}

const session = {
  userId: 'user',
  walletAddress: WALLET,
  getAccessToken: () => Promise.resolve('token'),
}

// Server rendering separates adjacent text with comments; the browser does not.
const text = (html: string) => html.replaceAll('<!-- -->', '')

function rows(items: TransactionActivityItem[]) {
  return text(
    renderToString(
      <TransactionRows items={items} onOpen={() => {}} now={now} />,
    ),
  )
}

// The drawer links to other dashboard pages, so it renders inside a router.
const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ['/dashboard/transactions'] }),
})

function detail(item: TransactionActivityItem) {
  return text(
    renderToString(
      <RouterContextProvider router={router}>
        <DashboardSessionProvider value={session}>
          <TransactionDetail item={item} onClose={() => {}} now={now} />
        </DashboardSessionProvider>
      </RouterContextProvider>,
    ),
  )
}

test('a confirmed swap shows when, what, who, how much and its signature', () => {
  const html = rows([swap])
  expect(html).toContain('2:31 PM')
  expect(html).toContain('Swap USDC for SOL')
  expect(html).toContain('≈ 0.0062 SOL received')
  expect(html).toContain('Codex')
  expect(html).toContain('Embedded')
  expect(html).toContain('−1')
  expect(html).toContain('USDC')
  expect(html).toContain(
    `https://explorer.solana.com/tx/${SIGNATURE}?cluster=devnet`,
  )
  expect(html).toContain('4vJ9…aJe9')
  // Confirmed is the quiet default: no status mark.
  expect(html).not.toContain('Confirmed')
})

test('days are bands with a count, and exceptions get a mark', () => {
  const html = rows([swap, deposit, openLink, failed])
  expect(html).toContain('Today')
  expect(html).toContain('3 transactions')
  expect(html).toContain('Yesterday')
  expect(html).toContain('1 transaction<')
  expect(html).toContain('Pending')
  expect(html).toContain('Failed')
  expect(html).toContain('Rejected by the chain. Nothing moved.')
  expect(html).toContain('line-through')
  // An open link has no signature yet, so no Explorer link for it.
  expect(html.split('explorer.solana.com').length - 1).toBe(3)
})

test('a deposit is money in, in lime, from an address', () => {
  const html = rows([deposit])
  expect(html).toContain('Deposit USDC')
  expect(html).toContain('From 7xKX…gAsU')
  expect(html).toContain('+25')
  expect(html).toContain('bg-lime')
})

test('the drawer explains the status and names the signer', () => {
  const html = detail(swap)
  expect(html).toContain('Confirmed on chain.')
  expect(html).toContain('−1 USDC')
  expect(html).toContain('+0.0062 SOL')
  expect(html).toContain('Your LanaTools wallet')
  expect(html).toContain('Embedded, no approval')
  expect(html).toContain('454798245, finalized')
  expect(html).toContain(SIGNATURE)
  expect(html).toContain('View on Solana Explorer')
})

test('an open link offers the review page and says what it is waiting for', () => {
  const html = detail(openLink)
  expect(html).toContain('Pending')
  expect(html).toContain('(open)')
  expect(html).toContain(
    'Waiting for someone to open the review link and sign.',
  )
  expect(html).toContain('http://localhost:5173/tx/send-1')
  expect(html).toContain('Open review page')
  expect(html).toContain('Expires')
  expect(html).toContain(RECIPIENT)
})

test('a failed swap is struck through with its error code', () => {
  const html = detail(failed)
  expect(html).toContain('The chain rejected this transaction. Nothing moved.')
  expect(html).toContain('chain_failed')
  expect(html).toContain('line-through')
})

const tradedSwap: TransactionActivityItem = {
  ...swap,
  id: 'swap-3',
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
        icon: 'https://example.com/usdc.png',
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
}
const perpOrder: TransactionActivityItem = {
  ...swap,
  id: 'perp-1',
  tool: 'phoenix_market_order',
  network: 'mainnet',
  review: {
    title: 'Place a Phoenix market order',
    description: 'Market buy (long): 0.1 SOL perp now',
    actionLabel: 'Place a Phoenix market order',
    fields: [
      { label: 'limitPrice', value: '110.15' },
      { label: 'Notice', value: 'This order expires about a minute after.' },
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
}
const phoenixDeposit: TransactionActivityItem = {
  ...perpOrder,
  id: 'perp-2',
  tool: 'phoenix_deposit',
  review: {
    ...perpOrder.review,
    fields: [],
    trade: {
      kind: 'perp',
      venue: 'phoenix',
      action: 'deposit',
      amountUsdc: '250',
    },
  },
}

test('a swap row shows what it paid with what came back under it', () => {
  const html = rows([tradedSwap])
  expect(html).toContain('Swap USDC → SOL')
  expect(html).toContain('Jupiter · 1 SOL ≈ 109.529 USDC')
  expect(html).toContain('−1')
  expect(html).toContain('≈ +0.00913')
})

test('a perp row reads as the trade, with an unsigned notional', () => {
  const html = rows([perpOrder, phoenixDeposit])
  expect(html).toContain('Buy 0.1 SOL-PERP')
  expect(html).toContain('Phoenix · Market, at most $110.15')
  expect(html).toContain('$10.96')
  expect(html).toContain('notional')
  expect(html).not.toContain('Place a Phoenix market order')
  // Collateral leaving the wallet is wallet money.
  expect(html).toContain('Deposit to Phoenix')
  expect(html).toContain('−250')
})

test('a swap drawer shows the two legs with token logos', () => {
  const html = detail(tradedSwap)
  expect(html).toContain('You paid')
  expect(html).toContain('You received, estimated')
  expect(html).toContain('https://example.com/usdc.png')
  expect(html).toContain('0.00913')
  expect(html).toContain('Minimum receive')
  expect(html).toContain('0.00908 SOL')
  expect(html).toContain('Route')
})

test('a perp drawer shows the order ticket, notices and the account link', () => {
  const html = detail(perpOrder)
  expect(html).toContain('0.1 SOL')
  expect(html).toContain('$10.96 notional at the best price, $109.60')
  expect(html).toContain('Market, fill or cancel')
  expect(html).toContain('at most $110.15')
  expect(html).toContain('$0.003836')
  expect(html).toContain('This order expires about a minute after.')
  expect(html).toContain(`/dashboard/perps/${WALLET}`)
  expect(html).toContain('Open account →')
  // Raw tool keys are not shown once the trade says the same thing.
  expect(html).not.toContain('limitPrice')
})

test('a read fill and swap output replace the estimates', () => {
  const filled: TransactionActivityItem = {
    ...perpOrder,
    receipt: {
      signature: SIGNATURE,
      slot: '1',
      commitment: 'finalized',
      fill: {
        size: '0.1',
        price: '109.64',
        feeUsdc: '0.0038',
        realizedPnlUsdc: '0',
      },
    },
  }
  expect(rows([filled])).toContain('Phoenix · Filled at $109.64')
  expect(detail(filled)).toContain(
    'Filled 0.1 at $109.64 each, $10.96 notional',
  )
  const swapped: TransactionActivityItem = {
    ...tradedSwap,
    receipt: {
      signature: SIGNATURE,
      slot: '1',
      commitment: 'finalized',
      received: {
        mint: 'So11111111111111111111111111111111111111112',
        amount: '0.009101',
      },
    },
  }
  const row = rows([swapped])
  expect(row).toContain('+0.009101')
  expect(row).not.toContain('≈ +')
  expect(detail(swapped)).toContain('>You received<')
})
