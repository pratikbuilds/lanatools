import { address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { TOKEN_PROGRAM } from '../checks'
import {
  BLOCKHASH,
  KEYS,
  PERMISSION,
  REGISTERED_TRADER_ACCOUNT_DATA,
  TRADER_ACCOUNT_DATA,
  WALLET,
  accountInfo,
  fakePhoenix,
  fakeRpc,
  tokenAccountData,
} from '../fixtures'
import {
  PHOENIX_PROGRAM,
  traderAccountAddress,
  usdcAccountAddress,
} from '../rise'
import { runTradeTool } from '../tool'
import { messageOf } from '../transaction'
import { activateAccount } from './activate'
import { deposit } from './deposit'
import { withdraw } from './withdraw'

const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }
const TRADER = await traderAccountAddress(WALLET)
const USDC = await usdcAccountAddress(WALLET)

const NONCE = {
  nonce_id: 'nonce-1',
  message: 'Sign in to Phoenix: nonce-1',
  expires_at: '2026-10-08T12:00:00Z',
}

/** An RPC whose accounts are `accounts`; simulation succeeds. */
function chain(accounts: Record<string, ReturnType<typeof accountInfo>>) {
  return fakeRpc({
    getAccountInfo: (account) => accounts[String(account)] ?? { value: null },
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed: 30_000n, logs: [] },
    }),
  })
}

const activated = {
  [TRADER]: accountInfo(PHOENIX_PROGRAM, TRADER_ACCOUNT_DATA),
}

test('activation of a new wallet is a referral transaction Phoenix submits', async () => {
  const { rpc } = chain({
    [WALLET]: accountInfo(
      address('11111111111111111111111111111111'),
      new Uint8Array(),
      41_615_528n,
    ),
  })
  const phoenix = fakePhoenix({
    '/v1/view/exchange/keys': KEYS,
    '/v1/referral/activation-permission': PERMISSION,
    '/v1/auth/nonce': NONCE,
  })
  const outcome = await runTradeTool(
    activateAccount,
    { wallet: WALLET },
    { rpc, fees: FEES, fetch: phoenix.fetch },
  )
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  expect(outcome.result).toMatchObject({
    wallet: WALLET,
    lastValidBlockHeight: '500',
    simulation: { ok: true, computeUnits: 30_000 },
    submit: {
      via: 'phoenix-referral',
      referralCode: '4L2RQ06K',
      recentBlockhash: BLOCKHASH,
      login: { message: NONCE.message, nonceId: 'nonce-1' },
    },
    details: {
      referralCode: '4L2RQ06K',
      traderAccount: TRADER,
      registers: 'yes',
      walletSol: '0.041615528',
    },
  })
  // No compute budget: Phoenix checks the activation's exact shape.
  expect(messageOf(outcome.result.transaction).instructions).toHaveLength(2)
})

test('an activated wallet has nothing to activate', async () => {
  const { rpc, calls } = chain(activated)
  const phoenix = fakePhoenix({})
  expect(
    await runTradeTool(
      activateAccount,
      { wallet: WALLET },
      { rpc, fees: FEES, fetch: phoenix.fetch },
    ),
  ).toEqual({
    ok: true,
    result: {
      status: 'nothing_to_do',
      wallet: WALLET,
      summary: "This wallet's Phoenix account is already activated.",
    },
  })
  expect(phoenix.requests).toEqual([])
  expect(calls.map(([method]) => method)).toEqual([
    'getAccountInfo',
    'getAccountInfo',
  ])
})

test('a trader account Phoenix does not own is refused', async () => {
  const { rpc } = chain({
    [TRADER]: accountInfo(TOKEN_PROGRAM, TRADER_ACCOUNT_DATA),
  })
  expect(
    await runTradeTool(
      activateAccount,
      { wallet: WALLET },
      { rpc, fees: FEES, fetch: fakePhoenix({}).fetch },
    ),
  ).toMatchObject({ ok: false, error: { code: 'upstream_error' } })
})

test('a referral code must look like one', async () => {
  const { rpc } = chain({})
  expect(
    await runTradeTool(
      activateAccount,
      { wallet: WALLET, referralCode: 'not a code!' },
      { rpc, fees: FEES, fetch: fakePhoenix({}).fetch },
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'invalid_input',
      message: 'Expected a Phoenix referral code',
    },
  })
})

test('a deposit needs an activated account and enough USDC', async () => {
  const phoenix = fakePhoenix({ '/v1/view/exchange/keys': KEYS })
  const opts = (accounts: Parameters<typeof chain>[0]) => ({
    rpc: chain(accounts).rpc,
    fees: FEES,
    fetch: phoenix.fetch,
  })
  const usdc = (amount: bigint) =>
    accountInfo(TOKEN_PROGRAM, tokenAccountData(amount))

  expect(
    await runTradeTool(deposit, { wallet: WALLET, amount: '1' }, opts({})),
  ).toMatchObject({ ok: false, error: { code: 'not_activated' } })

  expect(
    await runTradeTool(
      deposit,
      { wallet: WALLET, amount: '10' },
      opts({ ...activated, [USDC]: usdc(5_000_000n) }),
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: 'insufficient_funds',
      message: 'The wallet holds 5 USDC, less than 10',
    },
  })

  const outcome = await runTradeTool(
    deposit,
    { wallet: WALLET, amount: '2.5' },
    opts({ ...activated, [USDC]: usdc(5_000_000n) }),
  )
  expect(outcome).toMatchObject({
    ok: true,
    result: {
      status: 'ready',
      summary: 'Deposit 2.5 USDC into the Phoenix cross-margin account',
      details: { amountUsdc: '2.5', walletUsdc: '5' },
      submit: { via: 'rpc' },
    },
  })
})

const traderState = (collateral: string) => ({
  authority: WALLET,
  snapshot: {
    subaccounts: [
      { subaccountIndex: 0, collateral, positions: [], orders: [] },
    ],
  },
})
const open = { active: true, withdrawalsAvailable: true }

test('a withdrawal is checked against collateral and warns about the queue', async () => {
  const { rpc } = chain({})
  const run = (amount: string, answers: Record<string, unknown>) =>
    runTradeTool(
      withdraw,
      { wallet: WALLET, amount },
      {
        rpc,
        fees: FEES,
        fetch: fakePhoenix({ '/v1/view/exchange/keys': KEYS, ...answers })
          .fetch,
      },
    )
  const state = `/v1/trader/state/${WALLET}`

  expect(
    await run('1', { [state]: 404, '/v1/view/exchange/status': open }),
  ).toMatchObject({ ok: false, error: { code: 'not_activated' } })
  expect(
    await run('1', {
      [state]: traderState('5000000'),
      '/v1/view/exchange/status': { ...open, withdrawalsAvailable: false },
    }),
  ).toMatchObject({ ok: false, error: { code: 'market_unavailable' } })
  expect(
    await run('6', {
      [state]: traderState('5000000'),
      '/v1/view/exchange/status': open,
    }),
  ).toMatchObject({ ok: false, error: { code: 'insufficient_funds' } })

  const outcome = await run('5', {
    [state]: traderState('5000000'),
    '/v1/view/exchange/status': open,
  })
  expect(outcome).toMatchObject({
    ok: true,
    result: {
      status: 'ready',
      summary:
        'Withdraw 5 USDC from the Phoenix cross-margin account to the wallet',
      details: { amountUsdc: '5', collateralUsdc: '5' },
      warnings: [
        "Withdrawals go through Phoenix's queue and may be delayed or dropped.",
        'Open positions keep their margin; Phoenix rejects a withdrawal that would leave too little.',
      ],
    },
  })
})

test('a registered account only needs onboarding, and pays no new rent', async () => {
  const { rpc } = chain({
    [TRADER]: accountInfo(PHOENIX_PROGRAM, REGISTERED_TRADER_ACCOUNT_DATA),
  })
  const outcome = await runTradeTool(
    activateAccount,
    { wallet: WALLET },
    {
      rpc,
      fees: FEES,
      fetch: fakePhoenix({
        '/v1/view/exchange/keys': KEYS,
        '/v1/referral/activation-permission': PERMISSION,
        '/v1/auth/nonce': NONCE,
      }).fetch,
    },
  )
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  expect(outcome.result).toMatchObject({
    summary:
      "Finish activating this wallet's Phoenix account with referral code 4L2RQ06K: the account already exists, so the wallet pays only the fee",
    details: { registers: 'no, already registered', walletSol: '0' },
    warnings: [
      'Phoenix co-signs and submits this transaction; the wallet also signs a login message for Phoenix, which moves no funds.',
      'The wallet has no SOL to pay the rent and fee.',
    ],
  })
  expect(messageOf(outcome.result.transaction).instructions).toHaveLength(1)
})
