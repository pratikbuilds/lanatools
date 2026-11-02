import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { SOL_DECIMALS, sol, usdc } from '../../units'
import { fetchAccount, rentExemptMinimum, tokenBalance } from '../chain'
import { DEPOSIT_PROGRAMS, checkCollateral, checkSolDeposit } from '../checks'
import { toLamports, toUSDCUnits } from '../price'
import {
  depositInstructions,
  solDepositCredit,
  solDepositHeadroom,
  solDepositInstructions,
  traderAccountAddress,
  usdcAccountAddress,
} from '../rise'
import { CollateralAssets, ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import type { Prepared, TradeContext } from '../tool'
import { crossCollateral, perpTrade, requireActivated } from './shared'

/** An amount of collateral as the agent types it. */
export const CollateralAmount = z
  .string()
  .trim()
  .describe(
    'Amount as a decimal string, e.g. "25" or "12.5"; at most 6 decimals for USDC, 9 for SOL',
  )

export const CollateralAsset = z
  .enum(['USDC', 'SOL'])
  .default('USDC')
  .describe('The collateral to move: USDC (default) or SOL')

/** A range of margin discounts in basis points, as a person reads it. */
function discountText(minBps: number, maxBps: number) {
  const percent = (bps: number) => `${bps / 100}%`
  return minBps === maxBps
    ? percent(minBps)
    : `${percent(minBps)} to ${percent(maxBps)}`
}

async function depositUsdc(
  context: TradeContext,
  wallet: Address,
  input: string,
): Promise<Prepared> {
  const { phoenix, rpc } = context
  const amount = toUSDCUnits(input)
  const [held, keys] = await Promise.all([
    usdcAccountAddress(wallet).then((account) => fetchAccount(rpc, account)),
    phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
    requireActivated(context, wallet),
  ])
  const balance = tokenBalance(held)
  if (amount > balance)
    throw new PhoenixError(
      'insufficient_funds',
      `The wallet holds ${usdc(balance.toString())} USDC, less than ${usdc(amount.toString())}`,
    )

  const instructions = await depositInstructions(wallet, keys, amount)
  checkCollateral(instructions, { kind: 'deposit', amount })
  return {
    kind: 'instructions',
    wallet,
    instructions,
    summary: `Deposit ${usdc(amount.toString())} USDC into the Phoenix cross-margin account`,
    details: {
      amountUsdc: usdc(amount.toString()),
      walletUsdc: usdc(balance.toString()),
    },
    trade: perpTrade('deposit', {
      asset: 'USDC',
      amountUsdc: usdc(amount.toString()),
    }),
    warnings: [],
  }
}

/** Phoenix's terms for SOL collateral; refuses when it is not accepted. */
async function solTerms({ phoenix }: TradeContext) {
  const { assets } = await phoenix.get(
    '/v1/collateral/assets',
    CollateralAssets,
  )
  const asset = assets.find((entry) => entry.symbol === 'SOL')
  if (!asset?.spot?.isActive)
    throw new PhoenixError(
      'market_unavailable',
      'Phoenix is not accepting SOL as collateral right now',
    )
  if (asset.decimals !== SOL_DECIMALS)
    throw new PhoenixError(
      'upstream_error',
      'Phoenix sent unexpected decimals for SOL',
    )
  return asset.spot
}

async function depositSol(
  context: TradeContext,
  wallet: Address,
  input: string,
): Promise<Prepared> {
  const { phoenix, rpc } = context
  const lamports = toLamports(input)
  const trader = await requireActivated(context, wallet)
  const [held, terms, collateral, rentExemptLamports, keys, traderAccount] =
    await Promise.all([
      fetchAccount(rpc, wallet),
      solTerms(context),
      crossCollateral(context, wallet),
      rentExemptMinimum(rpc, trader.data.length),
      phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      traderAccountAddress(wallet),
    ])
  // Without the trader's own cap, lamports could land uncounted.
  if (!collateral.sol)
    throw new PhoenixError(
      'upstream_error',
      "Phoenix sent no SOL collateral row for this wallet's account",
    )

  const room = {
    caps: terms,
    accountedLamports: collateral.sol.balance,
    traderMaxLamports: collateral.sol.maxBalance,
    accountLamports: trader.lamports,
    rentExemptLamports,
  }
  const headroom = solDepositHeadroom(room)
  if (lamports > headroom)
    throw new PhoenixError(
      'invalid_input',
      `Phoenix can count at most ${sol(headroom.toString())} more SOL as collateral here, less than ${sol(lamports.toString())}; anything above that would land uncounted`,
    )

  // The wallet is also the fee payer, so all of its SOL cannot go in.
  const balance = held?.lamports ?? 0n
  if (lamports >= balance)
    throw new PhoenixError(
      'insufficient_funds',
      `The wallet holds ${sol(balance.toString())} SOL, not enough for ${sol(lamports.toString())} plus network fees`,
    )

  const instructions = await solDepositInstructions(wallet, keys, lamports)
  checkSolDeposit(instructions, { wallet, traderAccount, lamports })
  const credit = solDepositCredit(room, lamports)
  const amount = sol(lamports.toString())
  return {
    kind: 'instructions',
    wallet,
    instructions,
    summary: `Deposit ${amount} SOL into the Phoenix cross-margin account`,
    details: {
      amountSol: amount,
      walletSol: sol(balance.toString()),
      collateralSol: sol(collateral.sol.balance.toString()),
      headroomSol: sol(headroom.toString()),
    },
    trade: perpTrade('deposit', { asset: 'SOL', amountSol: amount }),
    warnings: [
      "SOL's value moves with its price, so your margin can change on its own.",
      `Only part of it counts toward margin: Phoenix currently discounts SOL by ${discountText(terms.minMarginDiscountBps, terms.maxMarginDiscountBps)}.`,
      'Phoenix may convert some of it to USDC if your USDC balance goes negative.',
      'It does not raise your USDC withdrawal limit.',
      ...(credit < lamports
        ? [
            `Phoenix will count ${sol(credit.toString())} SOL of this deposit; the rest refills the rent the trader account is short of.`,
          ]
        : []),
    ],
  }
}

export const deposit = defineTradeTool({
  name: 'phoenix_deposit',
  title: 'Deposit collateral into Phoenix',
  description: [
    "Prepares a deposit of the wallet's USDC (default) or SOL into its Phoenix cross-margin account, as collateral for perps.",
    'Only part of SOL counts toward margin, and an amount above what Phoenix can count is refused.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({ amount: CollateralAmount, asset: CollateralAsset })
    .strict(),
  programs: DEPOSIT_PROGRAMS,
  async prepare(context, input) {
    const wallet = address(input.wallet)
    return input.asset === 'SOL'
      ? depositSol(context, wallet, input.amount)
      : depositUsdc(context, wallet, input.amount)
  },
})
