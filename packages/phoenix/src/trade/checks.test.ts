import { address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { SelfTradeBehavior } from '@ellipsis-labs/rise'
import type { Address, Instruction } from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_PROGRAM,
  checkActivation,
  checkCancel,
  checkCollateral,
  checkInstructions,
  checkOrder,
  checkSolDeposit,
  checkSolWithdraw,
} from './checks'
import {
  KEYS,
  ONBOARD_DATA,
  OTHER,
  WALLET,
  marketOrderData,
  phoenixInstruction,
  postOnlyData,
  registerTraderData,
} from './fixtures'
import {
  EMBER_PROGRAM,
  SOL_ACCOUNTS,
  cancelData,
  depositInstructions,
  solData,
  solDepositInstructions,
  solWithdrawInstruction,
  traderAccountAddress,
  withdrawInstructions,
} from './rise'
import type { OrderSpec } from './rise'

const depositInstructionsFixture = await depositInstructions(
  WALLET,
  KEYS,
  2_500_000n,
)
const withdrawInstructionsFixture = await withdrawInstructions(
  WALLET,
  KEYS,
  1_000_000n,
)
const isDefined = (instruction: Instruction | undefined) =>
  instruction !== undefined

const SYSTEM_PROGRAM = address('11111111111111111111111111111111')
const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111')

const expected: OrderSpec = {
  kind: 'market',
  side: 'buy',
  priceInTicks: 11573n,
  numBaseLots: 10n,
  reduceOnly: false,
  lastValidSlot: 1_000n,
}

test('instructions the wallet signs, on trade programs, pass', () => {
  expect(() =>
    checkInstructions(
      [
        phoenixInstruction(),
        phoenixInstruction(undefined, { program: ASSOCIATED_TOKEN_PROGRAM }),
      ],
      { wallet: WALLET },
    ),
  ).not.toThrow()
})

test('another program fails, including compute budget from a tool', () => {
  for (const program of [SYSTEM_PROGRAM, COMPUTE_BUDGET])
    expect(() =>
      checkInstructions([phoenixInstruction(undefined, { program })], {
        wallet: WALLET,
      }),
    ).toThrow(`unexpected program ${program}`)
})

test('a tool can allow another program for its own instructions', () => {
  expect(() =>
    checkInstructions(
      [phoenixInstruction(undefined, { program: SYSTEM_PROGRAM })],
      { wallet: WALLET, programs: [SYSTEM_PROGRAM] },
    ),
  ).not.toThrow()
})

test('a signer other than the wallet fails unless named as a co-signer', () => {
  const instruction = phoenixInstruction(undefined, {
    signers: [WALLET, OTHER],
  })
  expect(() => checkInstructions([instruction], { wallet: WALLET })).toThrow(
    `unexpected signer ${OTHER}`,
  )
  expect(() =>
    checkInstructions([instruction], { wallet: WALLET, coSigners: [OTHER] }),
  ).not.toThrow()
})

test('nothing to sign fails; an instruction the fee payer alone signs passes', () => {
  expect(() => checkInstructions([], { wallet: WALLET })).toThrow(
    'no instructions',
  )
  expect(() =>
    checkInstructions([phoenixInstruction(undefined, { signers: [] })], {
      wallet: WALLET,
    }),
  ).not.toThrow()
})

test('check failures are check_failed errors that say nothing was signed', () => {
  expect(() => checkInstructions([], { wallet: WALLET })).toThrow(
    expect.objectContaining({
      code: 'check_failed',
      retryable: false,
      message:
        'The built Phoenix transaction failed a safety check (no instructions); nothing was signed',
    }),
  )
})

test('a market order that matches the request passes', () => {
  expect(() =>
    checkOrder(phoenixInstruction(marketOrderData()), expected),
  ).not.toThrow()
})

test('a market order without a price limit never passes', () => {
  expect(() =>
    checkOrder(
      phoenixInstruction(marketOrderData({ priceInTicks: null })),
      expected,
    ),
  ).toThrow('the order has no price limit')
})

test('a market order that differs from the request fails', () => {
  for (const [fields, field] of [
    [{ buy: false }, 'side'],
    [{ priceInTicks: 11574n }, 'priceInTicks'],
    [{ lots: 11n }, 'numBaseLots'],
    [{ minLots: 10n }, 'minBaseLotsToFill'],
    [{ lastValidSlot: null }, 'lastValidSlot'],
    [{ reduceOnly: true }, 'reduceOnly'],
    [{ cancelExisting: true }, 'cancelExisting'],
  ] as const)
    expect(() =>
      checkOrder(phoenixInstruction(marketOrderData(fields)), expected),
    ).toThrow(`the order's ${field} does not match the request`)
})

test('anything else in the packet must match byte for byte', () => {
  expect(() =>
    checkOrder(
      phoenixInstruction(
        marketOrderData({ selfTradeBehavior: SelfTradeBehavior.CancelProvide }),
      ),
      expected,
    ),
  ).toThrow("the order's encoding differs from the request")
  expect(() =>
    checkOrder(
      phoenixInstruction(Uint8Array.of(...marketOrderData(), 0)),
      expected,
    ),
  ).toThrow("the order's encoding differs from the request")
})

test('a post-only order must not slide, and must be the kind asked for', () => {
  const postOnly: OrderSpec = {
    ...expected,
    kind: 'post_only',
    lastValidSlot: null,
  }
  expect(() =>
    checkOrder(phoenixInstruction(postOnlyData()), postOnly),
  ).not.toThrow()
  expect(() =>
    checkOrder(phoenixInstruction(postOnlyData({ slide: true })), postOnly),
  ).toThrow("the order's slide does not match the request")
  expect(() =>
    checkOrder(phoenixInstruction(postOnlyData()), {
      ...postOnly,
      kind: 'limit',
    }),
  ).toThrow("the order's kind does not match the request")
})

test("Rise's deposit and withdrawal pass the collateral check", async () => {
  expect(() =>
    checkCollateral(depositInstructionsFixture, {
      kind: 'deposit',
      amount: 2_500_000n,
    }),
  ).not.toThrow()
  expect(() =>
    checkCollateral(withdrawInstructionsFixture, {
      kind: 'withdraw',
      amount: 1_000_000n,
    }),
  ).not.toThrow()
})

test('a collateral amount or approval that differs from the request fails', () => {
  expect(() =>
    checkCollateral(depositInstructionsFixture, {
      kind: 'deposit',
      amount: 2_500_001n,
    }),
  ).toThrow('the Ember deposit amount does not match the request')
  expect(() =>
    checkCollateral(withdrawInstructionsFixture, {
      kind: 'withdraw',
      amount: 2_000_000n,
    }),
  ).toThrow('the token approval is not limited to the amount for Ember')

  const [create, approve, ...rest] = withdrawInstructionsFixture
  const otherDelegate = {
    ...approve,
    programAddress: TOKEN_PROGRAM,
    accounts: (approve?.accounts ?? []).map((account, index) =>
      index === 1 ? { ...account, address: OTHER } : account,
    ),
  }
  expect(() =>
    checkCollateral([create, otherDelegate, ...rest].filter(isDefined), {
      kind: 'withdraw',
      amount: 1_000_000n,
    }),
  ).toThrow('the token approval is not limited to the amount for Ember')
  expect(() =>
    checkCollateral(depositInstructionsFixture.slice(1), {
      kind: 'deposit',
      amount: 2_500_000n,
    }),
  ).toThrow('the deposit has unexpected steps')
})

test('an instruction that is not a Phoenix market order fails', () => {
  expect(() => checkOrder(phoenixInstruction(), expected)).toThrow(
    'the instruction is not a Phoenix order',
  )
  expect(() =>
    checkOrder(
      phoenixInstruction(marketOrderData(), {
        program: ASSOCIATED_TOKEN_PROGRAM,
      }),
      expected,
    ),
  ).toThrow('the order is not a Phoenix instruction')
})

// phoenixInstruction lists PHOENIX_PROGRAM and the signers as accounts; the
// trader account is the wallet here, so `traderAccount: WALLET` matches.
const activation = { traderAccount: WALLET, register: true }

test('a well-formed activation passes', () => {
  expect(() =>
    checkActivation(
      [
        phoenixInstruction(registerTraderData()),
        phoenixInstruction(ONBOARD_DATA),
      ],
      activation,
    ),
  ).not.toThrow()
  expect(() =>
    checkActivation([phoenixInstruction(ONBOARD_DATA)], {
      ...activation,
      register: false,
    }),
  ).not.toThrow()
})

test('an activation of another shape fails', () => {
  const onboard = phoenixInstruction(ONBOARD_DATA)
  for (const [instructions, reason] of [
    [[onboard], 'activation has unexpected instructions'],
    [
      [phoenixInstruction(registerTraderData()), onboard, onboard],
      'activation has unexpected instructions',
    ],
    [
      [
        phoenixInstruction(registerTraderData(), {
          program: ASSOCIATED_TOKEN_PROGRAM,
        }),
        onboard,
      ],
      'activation calls another program',
    ],
    [
      [phoenixInstruction(registerTraderData(), { signers: [OTHER] }), onboard],
      "activation is not for the wallet's trader account",
    ],
    [
      [phoenixInstruction(ONBOARD_DATA), onboard],
      'activation does not register the trader',
    ],
    [
      [phoenixInstruction(registerTraderData({ maxPositions: 64n })), onboard],
      'activation registers the wrong trader account',
    ],
    [
      [phoenixInstruction(registerTraderData({ subaccountIndex: 1 })), onboard],
      'activation registers the wrong trader account',
    ],
    [
      [
        phoenixInstruction(registerTraderData()),
        phoenixInstruction(registerTraderData()),
      ],
      'activation does not onboard the trader',
    ],
  ] as const)
    expect(() => checkActivation(instructions, activation)).toThrow(reason)
})

test('a cancel must be exactly the instruction for the orders asked for', () => {
  const targets = [{ priceInTicks: 5100n, orderSequenceNumber: 9n }]
  expect(() =>
    checkCancel(phoenixInstruction(cancelData(targets)), targets),
  ).not.toThrow()
  expect(() =>
    checkCancel(phoenixInstruction(cancelData(null)), null),
  ).not.toThrow()
  for (const [data, requested] of [
    [cancelData(null), targets],
    [cancelData(targets), null],
    [cancelData([{ priceInTicks: 5100n, orderSequenceNumber: 10n }]), targets],
  ] as const)
    expect(() => checkCancel(phoenixInstruction(data), requested)).toThrow(
      'the cancel does not match the orders requested',
    )
  expect(() =>
    checkCancel(
      phoenixInstruction(cancelData(null), { program: TOKEN_PROGRAM }),
      null,
    ),
  ).toThrow('the cancel is not a Phoenix instruction')
})

const TRADER = await traderAccountAddress(WALLET)
const LAMPORTS = 10_000_000n
const SOL_TERMS = { wallet: WALLET, traderAccount: TRADER, lamports: LAMPORTS }

/** A copy of `instruction` with the account at `index` replaced. */
function withAccount(
  instruction: Instruction,
  index: number,
  account: Address,
) {
  return {
    ...instruction,
    accounts: (instruction.accounts ?? []).map((entry, at) =>
      at === index ? { ...entry, address: account } : entry,
    ),
  }
}

test('a SOL deposit passes only as the exact three steps', async () => {
  const good = await solDepositInstructions(WALLET, KEYS, LAMPORTS)
  const [realloc, transfer, sync] = good
  if (!realloc || !transfer || !sync) throw new Error('three steps')
  expect(() => checkSolDeposit(good, SOL_TERMS)).not.toThrow()

  const { payer, trader, traderAccount } = SOL_ACCOUNTS.realloc
  const { source, destination } = SOL_ACCOUNTS.transfer
  for (const [instructions, reason] of [
    [[realloc, transfer], 'the SOL deposit has unexpected steps'],
    [[...good, transfer], 'the SOL deposit has unexpected steps'],
    [
      [transfer, realloc, sync],
      'the ReallocTrader step calls the wrong program',
    ],
    [
      [realloc, sync, transfer],
      'the SOL transfer step calls the wrong program',
    ],
    [
      [{ ...realloc, data: solData.sync() }, transfer, sync],
      'the ReallocTrader step does not match the request',
    ],
    [
      [withAccount(realloc, payer, OTHER), transfer, sync],
      "the rent payer is not the wallet's own",
    ],
    [
      [withAccount(realloc, trader, OTHER), transfer, sync],
      "the trader authority is not the wallet's own",
    ],
    [
      [withAccount(realloc, traderAccount, OTHER), transfer, sync],
      "the reallocated trader account is not the wallet's own",
    ],
    [
      [realloc, withAccount(transfer, destination, OTHER), sync],
      "the SOL destination is not the wallet's own",
    ],
    [
      [realloc, withAccount(transfer, source, OTHER), sync],
      "the SOL source is not the wallet's own",
    ],
    [
      [realloc, { ...transfer, data: solData.transfer(LAMPORTS + 1n) }, sync],
      'the SOL transfer step does not match the request',
    ],
    [
      [realloc, { ...transfer, programAddress: TOKEN_PROGRAM }, sync],
      'the SOL transfer step calls the wrong program',
    ],
    [
      [realloc, transfer, { ...sync, data: solData.realloc() }],
      'the SyncNative step does not match the request',
    ],
    [
      [
        realloc,
        transfer,
        withAccount(sync, SOL_ACCOUNTS.sync.traderAccount, OTHER),
      ],
      "the synced trader account is not the wallet's own",
    ],
  ] as const)
    expect(() => checkSolDeposit(instructions, SOL_TERMS)).toThrow(reason)
})

test('a SOL withdrawal passes only as one exact WithdrawNativeSol', async () => {
  const good = await solWithdrawInstruction(WALLET, KEYS, LAMPORTS)
  expect(() => checkSolWithdraw([good], SOL_TERMS)).not.toThrow()

  const { trader, traderAccount, destination } = SOL_ACCOUNTS.withdraw
  const withData = (data: Uint8Array) => [{ ...good, data }]
  const excess = Uint8Array.from(solData.withdraw(LAMPORTS))
  excess[8] = 1 // `withExcess`: would also take uncounted lamports.
  const allExcess = solData.withdraw(LAMPORTS).slice(0, 9)
  allExcess[8] = 0
  for (const [instructions, reason] of [
    [[good, good], 'the SOL withdrawal has unexpected steps'],
    [[], 'the SOL withdrawal has unexpected steps'],
    [
      [{ ...good, programAddress: EMBER_PROGRAM }],
      'the WithdrawNativeSol step calls the wrong program',
    ],
    [
      withData(solData.withdraw(LAMPORTS - 1n)),
      'the WithdrawNativeSol step does not match the request',
    ],
    [withData(excess), 'the WithdrawNativeSol step does not match the request'],
    [
      withData(allExcess),
      'the WithdrawNativeSol step does not match the request',
    ],
    [
      [withAccount(good, destination, OTHER)],
      "the withdrawal destination is not the wallet's own",
    ],
    [
      [withAccount(good, traderAccount, OTHER)],
      "the withdrawn trader account is not the wallet's own",
    ],
    [
      [withAccount(good, trader, OTHER)],
      "the withdrawing authority is not the wallet's own",
    ],
  ] as const)
    expect(() => checkSolWithdraw(instructions, SOL_TERMS)).toThrow(reason)
})
