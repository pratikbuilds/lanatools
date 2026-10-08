import { address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { SelfTradeBehavior } from '@ellipsis-labs/rise'
import type { Instruction } from '@solana/kit'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  TOKEN_PROGRAM,
  checkActivation,
  checkCollateral,
  checkInstructions,
  checkOrder,
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
import { depositInstructions, withdrawInstructions } from './rise'
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
