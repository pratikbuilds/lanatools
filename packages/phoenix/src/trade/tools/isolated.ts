import type { Address, Instruction } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { sol, usdc } from '../../units'
import { checkPhoenixBundle } from '../checks'
import type { BundleIntent } from '../checks'
import { exactNumber, toLamports, toUSDCUnits } from '../price'
import { decodeBundleStep } from '../rise'
import type { OrderMarket } from '../schemas'
import { ISOLATED_RISK } from '../tool'
import type { TradeContext } from '../tool'
import { traderBook } from './shared'

/**
 * What an isolated order adds to a cross one. Phoenix's server builds the
 * transaction through `context.orders`; this file decides what to ask for and
 * holds the answer to it.
 */

/** Seen in the live run: fees are USDC, so a SOL-only subaccount sells SOL. */
const SOL_PAYS_FEES =
  'Fees are charged in USDC, so with only SOL in this position Phoenix converts a little SOL to pay them; slightly less SOL comes back when it closes.'

const FIRST_USE_RENT =
  'This order creates a new Phoenix subaccount, which costs a small one-time rent in SOL. Treat it as spent.'

const Collateral = z.string().trim()

/** The order tools' margin inputs. Collateral has no default. */
export const marginInputs = {
  marginMode: z
    .enum(['cross', 'isolated'])
    .default('cross')
    .describe(
      'cross (default) trades from the cross-margin account; isolated trades in a separate subaccount funded by collateralUsdc and collateralSol',
    ),
  collateralUsdc: Collateral.optional().describe(
    'Isolated only: USDC to move from cross into the position, as a decimal string, e.g. "25". Opening a position needs this or collateralSol',
  ),
  collateralSol: Collateral.optional().describe(
    'Isolated only: SOL to move from cross into the position, as a decimal string, e.g. "0.05". Opening a position needs this or collateralUsdc',
  ),
}

type MarginInput = {
  marginMode: 'cross' | 'isolated'
  collateralUsdc?: string | undefined
  collateralSol?: string | undefined
}

/** Cross orders take no collateral: refines the order tools' arguments. */
export const CrossTakesNoCollateral = [
  (input: MarginInput) =>
    input.marginMode === 'isolated' ||
    (input.collateralUsdc === undefined && input.collateralSol === undefined),
  'collateralUsdc and collateralSol need marginMode isolated',
] as const

/**
 * Checks an isolated order against the wallet's account and states what it
 * moves. Refuses a market with a cross position (D2), and a transfer cross
 * cannot cover. Without collateral it only adds to an existing position.
 */
export async function isolatedFunding(
  context: TradeContext,
  wallet: Address,
  market: OrderMarket,
  input: MarginInput & { reduceOnly: boolean },
) {
  const collateralUsdc =
    input.collateralUsdc === undefined
      ? 0n
      : toUSDCUnits(input.collateralUsdc, 'collateralUsdc')
  const collateralLamports =
    input.collateralSol === undefined
      ? 0n
      : toLamports(input.collateralSol, 'collateralSol')
  const transfer = {
    ...(collateralUsdc > 0n
      ? { transferAmount: exactNumber(collateralUsdc, 'collateralUsdc') }
      : {}),
    ...(collateralLamports > 0n
      ? {
          transferSpotCollateralAmounts: {
            SOL: exactNumber(collateralLamports, 'collateralSol'),
          },
        }
      : {}),
  }
  const moves = collateralUsdc > 0n || collateralLamports > 0n

  const { snapshot } = await traderBook(context, wallet)
  const holdsMarket = (account: (typeof snapshot.subaccounts)[number]) =>
    account.positions.some(
      (position) =>
        position.symbol === market.symbol &&
        BigInt(position.basePositionLots) !== 0n,
    )
  const cross = snapshot.subaccounts.find(
    (account) => account.subaccountIndex === 0,
  )
  if (cross && holdsMarket(cross))
    throw new PhoenixError(
      'invalid_input',
      `${market.symbol} has an open cross position, so an isolated order is refused; close it or trade in cross margin`,
    )
  const isolated = snapshot.subaccounts
    .filter((account) => account.subaccountIndex !== 0 && holdsMarket(account))
    .map((account) => account.subaccountIndex)
  const [subaccount, second] = isolated
  if (second !== undefined)
    throw new PhoenixError(
      'invalid_input',
      `${market.symbol} is open in isolated subaccounts ${isolated.join(' and ')}, so this order cannot tell which to change`,
    )
  if (input.reduceOnly && (subaccount === undefined || moves))
    throw new PhoenixError(
      'invalid_input',
      'A reduce-only isolated order needs an open isolated position and moves no collateral',
    )
  if (subaccount === undefined && !moves)
    throw new PhoenixError(
      'invalid_input',
      'A new isolated position needs collateralUsdc or collateralSol',
    )

  const crossUsdc = BigInt(cross?.collateral ?? 0)
  if (collateralUsdc > crossUsdc)
    throw new PhoenixError(
      'insufficient_funds',
      `The cross account holds ${usdc(crossUsdc.toString())} USDC, less than the ${usdc(collateralUsdc.toString())} USDC of collateral; add funds with phoenix_deposit`,
    )
  const crossLamports = BigInt(
    cross?.spotCollaterals.find((spot) => spot.symbol === 'SOL')?.balance ?? 0,
  )
  if (collateralLamports > crossLamports)
    throw new PhoenixError(
      'insufficient_funds',
      `The cross account holds ${sol(crossLamports.toString())} SOL, less than the ${sol(collateralLamports.toString())} SOL of collateral; add funds with phoenix_deposit`,
    )

  const amounts = {
    ...(collateralUsdc > 0n
      ? { collateralUsdc: usdc(collateralUsdc.toString()) }
      : {}),
    ...(collateralLamports > 0n
      ? {
          collateralSol: sol(collateralLamports.toString()),
        }
      : {}),
  }
  const funded = [
    ...(amounts.collateralUsdc ? [`${amounts.collateralUsdc} USDC`] : []),
    ...(amounts.collateralSol ? [`${amounts.collateralSol} SOL`] : []),
  ].join(' and ')
  return {
    transfer,
    amounts,
    intent: {
      collateralUsdc,
      collateralLamports,
      ...(subaccount === undefined ? {} : { subaccount }),
    },
    /** One sentence for the summary. */
    sentence: moves
      ? `Funded with ${funded} from your cross account.`
      : 'Moves no new collateral.',
  }
}

export type IsolatedFunding = Awaited<ReturnType<typeof isolatedFunding>>

const registers = (instructions: readonly Instruction[]) =>
  instructions.some(
    ({ data }) =>
      decodeBundleStep(Uint8Array.from(data ?? []))?.kind === 'register',
  )

/**
 * Asks Phoenix's server for an isolated order and refuses any answer that is
 * not exactly it. Returns what the tool adds to a cross order's result.
 */
export async function placeIsolated({
  wallet,
  keys,
  market,
  order,
  funding,
  build,
}: {
  wallet: Address
  keys: BundleIntent['keys']
  market: OrderMarket
  order: NonNullable<BundleIntent['order']>
  funding: IsolatedFunding
  /** The call to `context.orders`. */
  build: () => Promise<Instruction[]>
}) {
  const instructions = await build()
  const { subaccount } = await checkPhoenixBundle(instructions, {
    wallet,
    keys,
    market,
    order,
    ...funding.intent,
  })
  return {
    instructions,
    details: {
      marginMode: 'isolated',
      subaccount: String(subaccount),
      ...funding.amounts,
    },
    terms: {
      marginMode: 'isolated' as const,
      subaccount,
      ...funding.amounts,
    },
    warnings: [
      ISOLATED_RISK,
      ...(funding.intent.collateralLamports > 0n &&
      funding.intent.collateralUsdc === 0n
        ? [SOL_PAYS_FEES]
        : []),
      ...(registers(instructions) ? [FIRST_USE_RENT] : []),
    ],
  }
}
