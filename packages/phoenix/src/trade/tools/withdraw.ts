import { address } from '@solana/kit'
import type { Address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { sol, usdc } from '../../units'
import { checkCollateral, checkSolWithdraw } from '../checks'
import { toLamports, toUSDCUnits } from '../price'
import {
  solWithdrawInstruction,
  traderAccountAddress,
  withdrawInstructions,
} from '../rise'
import { ExchangeKeys, ExchangeStatus } from '../schemas'
import { defineTradeTool } from '../tool'
import type { Prepared, TradeContext } from '../tool'
import { CollateralAmount, CollateralAsset } from './deposit'
import { crossCollateral, perpTrade } from './shared'

const MARGIN_WARNING =
  'Open positions keep their margin; Phoenix rejects a withdrawal that would leave too little.'

/** The account's collateral and the exchange keys, if Phoenix pays out now. */
async function readyToWithdraw(context: TradeContext, wallet: Address) {
  const { phoenix } = context
  const [collateral, status, keys] = await Promise.all([
    crossCollateral(context, wallet),
    phoenix.get('/v1/view/exchange/status', ExchangeStatus),
    phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
  ])
  if (!status.active || !status.withdrawalsAvailable)
    throw new PhoenixError(
      'market_unavailable',
      'Phoenix is not accepting withdrawals right now',
    )
  return { collateral, keys }
}

async function withdrawUsdc(
  context: TradeContext,
  wallet: Address,
  input: string,
): Promise<Prepared> {
  const amount = toUSDCUnits(input)
  const { collateral, keys } = await readyToWithdraw(context, wallet)
  if (amount > collateral.usdc)
    throw new PhoenixError(
      'insufficient_funds',
      `The cross-margin account holds ${usdc(collateral.usdc.toString())} USDC of collateral, less than ${usdc(amount.toString())}`,
    )

  const instructions = await withdrawInstructions(wallet, keys, amount)
  checkCollateral(instructions, { kind: 'withdraw', amount })
  return {
    kind: 'instructions',
    wallet,
    instructions,
    summary: `Withdraw ${usdc(amount.toString())} USDC from the Phoenix cross-margin account to the wallet`,
    details: {
      amountUsdc: usdc(amount.toString()),
      collateralUsdc: usdc(collateral.usdc.toString()),
    },
    trade: perpTrade('withdraw', {
      asset: 'USDC',
      amountUsdc: usdc(amount.toString()),
    }),
    warnings: [
      "Withdrawals go through Phoenix's queue and may be delayed or dropped.",
      MARGIN_WARNING,
    ],
  }
}

async function withdrawSol(
  context: TradeContext,
  wallet: Address,
  input: string,
): Promise<Prepared> {
  const lamports = toLamports(input)
  const { collateral, keys } = await readyToWithdraw(context, wallet)
  const held = collateral.sol?.balance ?? 0n
  if (lamports > held)
    throw new PhoenixError(
      'insufficient_funds',
      `The cross-margin account holds ${sol(held.toString())} SOL of collateral, less than ${sol(lamports.toString())}`,
    )

  const instructions = [await solWithdrawInstruction(wallet, keys, lamports)]
  checkSolWithdraw(instructions, {
    wallet,
    traderAccount: await traderAccountAddress(wallet),
    lamports,
  })
  const amount = sol(lamports.toString())
  return {
    kind: 'instructions',
    wallet,
    instructions,
    summary: `Withdraw ${amount} SOL from the Phoenix cross-margin account to the wallet`,
    details: { amountSol: amount, collateralSol: sol(held.toString()) },
    trade: perpTrade('withdraw', { asset: 'SOL', amountSol: amount }),
    warnings: [
      'SOL withdrawals clear immediately or fail; they are never queued.',
      MARGIN_WARNING,
    ],
  }
}

export const withdraw = defineTradeTool({
  name: 'phoenix_withdraw',
  title: 'Withdraw collateral from Phoenix',
  description: [
    "Prepares a withdrawal of USDC (default) or SOL collateral from the wallet's Phoenix cross-margin account back to the wallet.",
    "USDC goes through Phoenix's queue; SOL clears immediately or fails. Returns an unsigned transaction and its simulation; nothing is signed or sent.",
  ].join(' '),
  arguments: z
    .object({ amount: CollateralAmount, asset: CollateralAsset })
    .strict(),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    return input.asset === 'SOL'
      ? withdrawSol(context, wallet, input.amount)
      : withdrawUsdc(context, wallet, input.amount)
  },
})
