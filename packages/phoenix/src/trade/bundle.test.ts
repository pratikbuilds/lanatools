import { describe, expect, test } from 'bun:test'
import { AccountRole, address } from '@solana/kit'
import type { Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import { checkPhoenixBundle } from './checks'
import type { BundleIntent } from './checks'
import bundles from './fixtures/phoenix-bundles.json'
import {
  addMarginInstructions,
  decodeBundleStep,
  sweepInstructions,
  toInstruction,
  traderAccountAddress,
} from './rise'
import type { RiseInstruction } from './rise'
import { ExchangeKeys } from './schemas'

// Real responses from Phoenix's build routes, 2026-11-01. Wallets are public.
const A = address(bundles.wallets.A)
const D = address(bundles.wallets.D)
const STRANGER = address('11111111111111111111111111111112')
const keys = ExchangeKeys.parse(bundles.keys)
const GOLD = bundles.markets.GOLD
const instructions = (bundle: readonly RiseInstruction[]) =>
  bundle.map(toInstruction)

const open = instructions(bundles.openWithTpsl)
const openIntent: BundleIntent = {
  wallet: A,
  keys,
  market: GOLD,
  order: {
    kind: 'market',
    side: 'buy',
    priceInTicks: 39280n,
    numBaseLots: 10n,
    reduceOnly: false,
  },
  collateralUsdc: 2_000_000n,
  conditional: {
    assetId: GOLD.assetId,
    greater: {
      triggerDirection: 'greater',
      side: 'sell',
      orderKind: 'limit',
      triggerPriceInTicks: 42780n,
      executionPriceInTicks: 42780n,
    },
    less: {
      triggerDirection: 'less',
      side: 'sell',
      orderKind: 'ioc',
      triggerPriceInTicks: 35002n,
      executionPriceInTicks: 33057n,
    },
    sizeBaseLots: null,
    sizePercent: 100,
  },
}

const { conditional: _conditional, ...noTpsl } = openIntent
const { order: _order, ...noOrder } = openIntent

const refused = (bundle: Instruction[], intent: BundleIntent, reason: string) =>
  expect(
    checkPhoenixBundle(bundle, intent).catch((error: unknown) => {
      expect(error).toBeInstanceOf(PhoenixError)
      throw error
    }),
  ).rejects.toThrow(reason)

describe('checkPhoenixBundle accepts what Phoenix really builds', () => {
  test('an isolated market order with TP and SL', async () => {
    expect(await checkPhoenixBundle(open, openIntent)).toEqual({
      subaccount: 1,
    })
  })

  test('a short and a SOL-funded order', async () => {
    await checkPhoenixBundle(instructions(bundles.sellShort), {
      ...noTpsl,
      order: {
        kind: 'market',
        side: 'sell',
        priceInTicks: 38502n,
        numBaseLots: 10n,
        reduceOnly: false,
      },
    })
    await checkPhoenixBundle(instructions(bundles.openSol), {
      ...noTpsl,
      order: {
        kind: 'market',
        side: 'buy',
        priceInTicks: 39280n,
        numBaseLots: 1n,
        reduceOnly: false,
      },
      collateralUsdc: 0n,
      collateralLamports: 50_000_000n,
    })
  })

  test('limit and post-only orders', async () => {
    const order = {
      side: 'buy' as const,
      priceInTicks: 31113n,
      numBaseLots: 10n,
      reduceOnly: false,
    }
    await checkPhoenixBundle(instructions(bundles.limit), {
      ...noTpsl,
      order: { ...order, kind: 'limit' },
    })
    await checkPhoenixBundle(instructions(bundles.limitPost), {
      ...noTpsl,
      order: { ...order, kind: 'post_only' },
    })
  })

  test('closing an isolated position moves no collateral', async () => {
    const market = bundles.markets.STONK
    expect(
      await checkPhoenixBundle(instructions(bundles.close), {
        wallet: D,
        keys,
        market,
        subaccount: bundles.closeMeta.subaccount,
        order: {
          kind: 'market',
          side: 'buy',
          priceInTicks: 12972n,
          numBaseLots: 7n,
          reduceOnly: true,
        },
      }),
    ).toEqual({ subaccount: bundles.closeMeta.subaccount })
  })

  test('adding margin moves exactly that amount into the subaccount', async () => {
    const market = bundles.markets.STONK
    const amount = 2_500_000n
    expect(
      await checkPhoenixBundle(
        await addMarginInstructions(D, keys, 3, amount),
        { wallet: D, keys, market, subaccount: 3, collateralUsdc: amount },
      ),
    ).toEqual({ subaccount: 3 })
  })

  test('sweeps move nothing out of cross', async () => {
    const market = bundles.markets.STONK
    expect(
      await checkPhoenixBundle(await sweepInstructions(D, keys, 3), {
        wallet: D,
        keys,
        market,
        subaccount: 3,
      }),
    ).toEqual({ subaccount: 3 })
  })

  test('partial TP and SL on a cross position', async () => {
    const market = bundles.markets.ARM
    expect(
      await checkPhoenixBundle(instructions(bundles.tpsl), {
        wallet: D,
        keys,
        market,
        conditional: {
          assetId: market.assetId,
          greater: {
            triggerDirection: 'greater',
            side: 'sell',
            orderKind: 'limit',
            triggerPriceInTicks: 22913n,
            executionPriceInTicks: 22913n,
          },
          less: {
            triggerDirection: 'less',
            side: 'sell',
            orderKind: 'ioc',
            triggerPriceInTicks: 18747n,
            executionPriceInTicks: 17706n,
          },
          sizeBaseLots: null,
          sizePercent: 50,
        },
      }),
    ).toEqual({ subaccount: 0 })
  })
})

const replaceAccount = (from: string, to: string) =>
  open.map((instruction) => ({
    ...instruction,
    accounts: (instruction.accounts ?? []).map((account) =>
      account.address === from ? { ...account, address: address(to) } : account,
    ),
  }))

describe('checkPhoenixBundle refuses a wrong answer', () => {
  test('a wrong or changed order', async () => {
    const order = openIntent.order
    if (!order) throw new Error('fixture has an order')
    for (const [change, reason] of [
      [{ priceInTicks: 39000n }, 'priceInTicks'],
      [{ numBaseLots: 9n }, 'numBaseLots'],
      [{ side: 'sell' as const }, 'side'],
      [{ reduceOnly: true }, 'reduceOnly'],
      [{ kind: 'limit' as const }, 'kind'],
    ] as const)
      await refused(
        open,
        { ...openIntent, order: { ...order, ...change } },
        reason,
      )
  })

  test('collateral other than the amount asked for', () =>
    refused(
      open,
      { ...openIntent, collateralUsdc: 1_000_000n },
      'USDC collateral',
    ))

  test('collateral moved anywhere but cross to the subaccount', async () => {
    const child = await traderAccountAddress(A, 1)
    const swapped = open.map((instruction, index) =>
      index === 3
        ? {
            ...instruction,
            accounts: (instruction.accounts ?? []).map((account, position) =>
              position === 4 ? { ...account, address: child } : account,
            ),
          }
        : instruction,
    )
    await refused(swapped, openIntent, 'from cross to the subaccount')
  })

  test('an order or TP/SL placed in cross instead of the subaccount', async () => {
    const child = await traderAccountAddress(A, 1)
    const cross = await traderAccountAddress(A)
    const moved = (kind: string) =>
      open.map((instruction) =>
        decodeBundleStep(Uint8Array.from(instruction.data ?? []))?.kind === kind
          ? {
              ...instruction,
              accounts: (instruction.accounts ?? []).map((account) =>
                account.address === child
                  ? { ...account, address: cross }
                  : account,
              ),
            }
          : instruction,
      )
    await refused(moved('order'), openIntent, 'order is not placed')
    await refused(moved('place_conditional'), openIntent, 'TP/SL is not set')
  })

  test('another trader’s account', async () => {
    const child = await traderAccountAddress(A, 1)
    await refused(
      replaceAccount(child, await traderAccountAddress(D, 1)),
      openIntent,
      'unexpected account',
    )
  })

  test('a market other than the one asked for', () =>
    refused(
      open,
      { ...openIntent, market: { ...GOLD, marketPubkey: STRANGER } },
      'unexpected account',
    ))

  test('an order or TP/SL nobody asked for', async () => {
    await refused(open, noOrder, 'order nobody asked for')
    await refused(open, noTpsl, 'TP/SL nobody asked for')
  })

  test('a missing order or TP/SL', async () => {
    const withoutOrder = open.filter(
      (each) =>
        decodeBundleStep(Uint8Array.from(each.data ?? []))?.kind !== 'order',
    )
    await refused(withoutOrder, openIntent, 'order is missing')
    const withoutTpsl = open.filter(
      (each) =>
        decodeBundleStep(Uint8Array.from(each.data ?? []))?.kind !==
        'place_conditional',
    )
    await refused(withoutTpsl, openIntent, 'TP/SL is missing')
  })

  test('TP/SL terms that differ', async () => {
    const wanted = openIntent.conditional
    if (!wanted?.less) throw new Error('fixture has a stop')
    for (const conditional of [
      { ...wanted, sizePercent: 50 },
      { ...wanted, assetId: 1 },
      { ...wanted, greater: null },
      {
        ...wanted,
        less: { ...wanted.less, executionPriceInTicks: 30000n },
      },
    ])
      await refused(open, { ...openIntent, conditional }, 'TP/SL')
  })

  test('the wrong subaccount', () =>
    refused(open, { ...openIntent, subaccount: 2 }, 'wrong subaccount'))

  describe('adding margin', () => {
    const intent = (collateralUsdc: bigint, subaccount = 3): BundleIntent => ({
      wallet: D,
      keys,
      market: bundles.markets.STONK,
      subaccount,
      collateralUsdc,
    })

    test('another amount than asked for', async () => {
      const built = await addMarginInstructions(D, keys, 3, 1_000_000n)
      await refused(built, intent(2_000_000n), 'USDC collateral')
    })

    test('another subaccount than asked for', async () => {
      const built = await addMarginInstructions(D, keys, 3, 1_000_000n)
      await refused(built, intent(1_000_000n, 4), 'wrong subaccount')
    })

    test('collateral moved out of the subaccount', async () => {
      const cross = await traderAccountAddress(D)
      const child = await traderAccountAddress(D, 3)
      const reversed = (
        await addMarginInstructions(D, keys, 3, 1_000_000n)
      ).map((instruction) => ({
        ...instruction,
        accounts: (instruction.accounts ?? []).map((account) =>
          account.address === cross
            ? { ...account, address: child }
            : account.address === child
              ? { ...account, address: cross }
              : account,
        ),
      }))
      await refused(
        reversed,
        intent(1_000_000n),
        'from cross to the subaccount',
      )
    })
  })

  test('a close that takes collateral out of cross', async () => {
    const market = bundles.markets.STONK
    const { subaccount } = bundles.closeMeta
    await refused(
      [
        ...instructions(bundles.close),
        ...(await addMarginInstructions(D, keys, subaccount, 1n)),
      ],
      {
        wallet: D,
        keys,
        market,
        subaccount,
        order: {
          kind: 'market',
          side: 'buy',
          priceInTicks: 12972n,
          numBaseLots: 7n,
          reduceOnly: true,
        },
      },
      'USDC collateral',
    )
  })

  test('an instruction this check does not know', () => {
    const [first] = open
    if (!first) throw new Error('fixture has instructions')
    return refused(
      [...open, { ...first, data: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8) }],
      openIntent,
      'unknown Phoenix instruction',
    )
  })

  test('another program or signer', async () => {
    const [first] = open
    if (!first) throw new Error('fixture has instructions')
    await refused(
      [{ ...first, programAddress: STRANGER }, ...open],
      openIntent,
      'unexpected program',
    )
    await refused(
      [
        {
          ...first,
          accounts: [
            { address: STRANGER, role: AccountRole.READONLY_SIGNER },
            ...(first.accounts ?? []),
          ],
        },
        ...open,
      ],
      openIntent,
      'unexpected signer',
    )
  })
})
