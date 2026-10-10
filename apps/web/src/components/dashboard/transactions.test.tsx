import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
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

function detail(item: TransactionActivityItem) {
  return text(
    renderToString(
      <DashboardSessionProvider value={session}>
        <TransactionDetail item={item} onClose={() => {}} now={now} />
      </DashboardSessionProvider>,
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
