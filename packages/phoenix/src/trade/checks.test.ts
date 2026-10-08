import { address } from '@solana/kit'
import { expect, test } from 'bun:test'
import {
  ASSOCIATED_TOKEN_PROGRAM,
  checkActivation,
  checkInstructions,
  checkMarketOrder,
} from './checks'
import {
  ONBOARD_DATA,
  OTHER,
  WALLET,
  marketOrderData,
  phoenixInstruction,
  registerTraderData,
} from './fixtures'

const SYSTEM_PROGRAM = address('11111111111111111111111111111111')
const COMPUTE_BUDGET = address('ComputeBudget111111111111111111111111111111')

const expected = {
  side: 'buy',
  priceInTicks: 11573n,
  numBaseLots: 10n,
  minBaseLotsToFill: 1n,
  lastValidSlot: 1_000n,
  reduceOnly: false,
} as const

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
    checkMarketOrder(phoenixInstruction(marketOrderData()), expected),
  ).not.toThrow()
})

test('a market order without a price limit never passes', () => {
  expect(() =>
    checkMarketOrder(
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
  ] as const)
    expect(() =>
      checkMarketOrder(phoenixInstruction(marketOrderData(fields)), expected),
    ).toThrow(`the order's ${field} does not match the request`)
})

test('an instruction that is not a Phoenix market order fails', () => {
  expect(() => checkMarketOrder(phoenixInstruction(), expected)).toThrow(
    'the order is not a market order',
  )
  expect(() =>
    checkMarketOrder(
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
