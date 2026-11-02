import { describe, expect, test } from 'bun:test'
import { AccountRole, address } from '@solana/kit'
import type { AccountMeta, Instruction } from '@solana/kit'
import { PhoenixError } from '../client'
import { checkPhoenixBundle } from './checks'
import type { BundleIntent } from './checks'
import bundles from './fixtures/phoenix-bundles.json'
import {
  addMarginInstructions,
  conditionalOrdersAddress,
  decodeBundleStep,
  sweepInstructions,
  toInstruction,
  traderAccountAddress,
} from './rise'
import type { RiseInstruction } from './rise'
import { ExchangeKeys } from './schemas'

// Real responses from Phoenix's build routes, 2026-11-01. Wallets are public.
const A = address(bundles.wallets.A)
const C = address(bundles.wallets.C)
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
    lastValidSlot: null,
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

// A real wallet's live TP/SL: Phoenix's cancel route, 2026-11-01.
const cancelIntent: BundleIntent = {
  wallet: C,
  keys,
  market:
    bundles.markets[bundles.cancelMeta.symbol as keyof typeof bundles.markets],
  subaccount: 0,
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
        lastValidSlot: null,
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
        lastValidSlot: null,
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
      lastValidSlot: null,
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
          lastValidSlot: null,
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

  test('a fixed-size TP and SL on an isolated short', async () => {
    const meta = bundles.isolatedShortMeta
    const market = bundles.markets[meta.symbol as keyof typeof bundles.markets]
    expect(
      await checkPhoenixBundle(instructions(bundles.isolatedShort), {
        wallet: D,
        keys,
        market,
        subaccount: meta.subaccount,
        conditional: {
          assetId: market.assetId,
          greater: {
            triggerDirection: 'greater',
            side: 'buy',
            orderKind: 'ioc',
            triggerPriceInTicks: BigInt(meta.greaterTicks),
            executionPriceInTicks: BigInt(meta.worstTicks),
          },
          less: {
            triggerDirection: 'less',
            side: 'buy',
            orderKind: 'limit',
            triggerPriceInTicks: BigInt(meta.lessTicks),
            executionPriceInTicks: BigInt(meta.lessTicks),
          },
          sizeBaseLots: 1n,
          sizePercent: null,
        },
      }),
    ).toEqual({ subaccount: meta.subaccount })
  })

  test('cancelling each leg of a live TP/SL', async () => {
    const { slot } = bundles.cancelMeta
    expect(
      await checkPhoenixBundle(instructions(bundles.cancelGreater), {
        ...cancelIntent,
        cancels: [{ slot, leg: 'greater' }],
      }),
    ).toEqual({ subaccount: 0 })
    await checkPhoenixBundle(instructions(bundles.cancelLess), {
      ...cancelIntent,
      cancels: [{ slot, leg: 'less' }],
    })
  })

  test('cancelling both legs in one transaction', () =>
    checkPhoenixBundle(
      [
        ...instructions(bundles.cancelLess),
        ...instructions(bundles.cancelGreater),
      ],
      {
        ...cancelIntent,
        cancels: [
          { slot: bundles.cancelMeta.slot, leg: 'greater' },
          { slot: bundles.cancelMeta.slot, leg: 'less' },
        ],
      },
    ))
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
          lastValidSlot: null,
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

describe('checkPhoenixBundle holds a TP/SL cancel to the request', () => {
  const { slot } = bundles.cancelMeta
  const greater = instructions(bundles.cancelGreater)
  const less = instructions(bundles.cancelLess)
  const wantGreater = {
    ...cancelIntent,
    cancels: [{ slot, leg: 'greater' as const }],
  }

  test('a real cancel is one instruction of 7 accounts', () => {
    expect(greater).toHaveLength(1)
    expect(greater[0]?.accounts).toHaveLength(7)
    expect(decodeBundleStep(Uint8Array.from(greater[0]?.data ?? []))).toEqual({
      kind: 'cancel_conditional',
      index: slot,
      disableFirst: true,
      disableSecond: false,
    })
    expect(decodeBundleStep(Uint8Array.from(less[0]?.data ?? []))).toEqual({
      kind: 'cancel_conditional',
      index: slot,
      disableFirst: false,
      disableSecond: true,
    })
  })

  test('the other leg', () =>
    refused(less, wantGreater, 'cancels a TP/SL nobody asked to'))

  test('another slot', () =>
    refused(
      greater,
      { ...cancelIntent, cancels: [{ slot: slot + 1, leg: 'greater' }] },
      'cancels a TP/SL nobody asked to',
    ))

  test('a cancel nobody asked for', async () => {
    await refused(greater, cancelIntent, 'cancels a TP/SL nobody asked to')
    await refused(
      [...greater, ...less],
      wantGreater,
      'cancels a TP/SL nobody asked to',
    )
  })

  test('the same cancel twice', () =>
    refused(
      [...greater, ...greater],
      wantGreater,
      'cancels a TP/SL nobody asked to',
    ))

  test('a cancel that is missing', () =>
    refused(
      greater,
      {
        ...cancelIntent,
        cancels: [
          { slot, leg: 'greater' },
          { slot, leg: 'less' },
        ],
      },
      'TP/SL cancel is missing',
    ))

  test('a cancel that names no leg or both', async () => {
    const [instruction] = greater
    if (!instruction) throw new Error('fixture has an instruction')
    for (const flags of [
      [0, 0],
      [1, 1],
    ] as const) {
      const data = Uint8Array.from(instruction.data ?? [])
      data.set(flags, data.length - 2)
      await refused(
        [{ ...instruction, data }],
        wantGreater,
        'does not name one leg',
      )
    }
  })

  test('a cancel for another market', () =>
    refused(
      greater,
      {
        ...wantGreater,
        market: { ...cancelIntent.market, marketPubkey: STRANGER },
      },
      'unexpected account',
    ))

  test("a cancel of another trader's TP/SL", async () => {
    const [instruction] = greater
    if (!instruction) throw new Error('fixture has an instruction')
    const other = await conditionalOrdersAddress(await traderAccountAddress(D))
    await refused(
      [
        {
          ...instruction,
          accounts: (instruction.accounts ?? []).map((account, position) =>
            position === 6 ? { ...account, address: other } : account,
          ),
        },
      ],
      wantGreater,
      'unexpected account',
    )
  })

  test('a cancel for the wrong wallet', () =>
    refused(greater, { ...wantGreater, wallet: D }, 'unexpected'))

  test('accounts in the wrong places', async () => {
    const [instruction] = greater
    if (!instruction) throw new Error('fixture has an instruction')
    const accounts = [...(instruction.accounts ?? [])]
    const [trader, , market] = [accounts[3], accounts[4], accounts[5]]
    if (!trader || !market) throw new Error('fixture has accounts')
    accounts[3] = market
    accounts[5] = trader
    await refused(
      [{ ...instruction, accounts }],
      wantGreater,
      'another account or market',
    )
  })
})

describe('checkPhoenixBundle keeps collateral between the wallet’s accounts', () => {
  const swapAccounts = (
    bundle: Instruction[],
    kind: string,
    change: (accounts: AccountMeta[]) => AccountMeta[],
  ) =>
    bundle.map((instruction) =>
      decodeBundleStep(Uint8Array.from(instruction.data ?? []))?.kind === kind
        ? {
            ...instruction,
            accounts: change([
              ...(instruction.accounts ?? []),
            ] as AccountMeta[]),
          }
        : instruction,
    )
  const reversed = (accounts: AccountMeta[]) => {
    const [from, to] = [accounts[4], accounts[5]]
    if (!from || !to) throw new Error('fixture has both accounts')
    accounts[4] = to
    accounts[5] = from
    return accounts
  }
  const sol = instructions(bundles.openSol)
  const solIntent: BundleIntent = {
    ...noTpsl,
    order: {
      kind: 'market',
      side: 'buy',
      priceInTicks: 39280n,
      numBaseLots: 1n,
      reduceOnly: false,
      lastValidSlot: null,
    },
    collateralUsdc: 0n,
    collateralLamports: 50_000_000n,
  }

  test('SOL collateral going the wrong way', () =>
    refused(
      swapAccounts(sol, 'transfer_sol', reversed),
      solIntent,
      'from cross to the subaccount',
    ))

  test('SOL collateral sent to a stranger, even if Phoenix lists the stranger', async () => {
    const stranger = await traderAccountAddress(D, 1)
    const hostile = swapAccounts(sol, 'transfer_sol', (accounts) => {
      const to = accounts[5]
      if (!to) throw new Error('fixture has a destination')
      accounts[5] = { ...to, address: stranger }
      return accounts
    })
    await refused(
      hostile,
      {
        ...solIntent,
        keys: {
          ...keys,
          globalTraderIndex: [...keys.globalTraderIndex, stranger],
        },
      },
      'from cross to the subaccount',
    )
  })

  for (const kind of ['sweep_usdc', 'sweep_sol'])
    test(`a ${kind} going the wrong way`, () =>
      refused(
        swapAccounts(open, kind, reversed),
        openIntent,
        'from the subaccount to cross',
      ))

  test('a new isolated position in cross or a busy subaccount', async () => {
    await refused(open, { ...openIntent, occupied: [0, 1] }, 'already in use')
    expect(
      await checkPhoenixBundle(open, { ...openIntent, occupied: [0, 2] }),
    ).toEqual({ subaccount: 1 })
  })

  test('a subaccount registered with other settings', () => {
    const data = Uint8Array.from(open[0]?.data ?? [])
    // maxPositions follows the discriminator and two index bytes.
    const tampered = Uint8Array.from(data)
    tampered[data.length - 1] = 0xff
    return refused(
      open.map((each, index) =>
        index === 0 ? { ...each, data: tampered } : each,
      ),
      openIntent,
      'register',
    )
  })

  test('anything extra in the order bytes', () =>
    refused(
      open.map((each) =>
        decodeBundleStep(Uint8Array.from(each.data ?? []))?.kind === 'order'
          ? {
              ...each,
              data: Uint8Array.from([...(each.data ?? []), 0, 0, 0, 0]),
            }
          : each,
      ),
      openIntent,
      'encoding differs',
    ))
})
