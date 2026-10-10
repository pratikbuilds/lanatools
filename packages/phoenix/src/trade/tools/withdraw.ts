import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { TraderState } from '../../schemas'
import { usdc } from '../../units'
import { checkCollateral } from '../checks'
import { toUSDCUnits } from '../price'
import { withdrawInstructions } from '../rise'
import { ExchangeKeys, ExchangeStatus } from '../schemas'
import { defineTradeTool } from '../tool'
import { USDCAmount } from './deposit'

export const withdraw = defineTradeTool({
  name: 'phoenix_withdraw',
  title: 'Withdraw USDC from Phoenix',
  description: [
    "Prepares a withdrawal of collateral from the wallet's Phoenix cross-margin account back to its USDC.",
    "Withdrawals go through Phoenix's queue. Returns an unsigned transaction and its simulation; nothing is signed or sent.",
  ].join(' '),
  arguments: z.object({ amount: USDCAmount }).strict(),
  async prepare({ phoenix }, input) {
    const wallet = address(input.wallet)
    const amount = toUSDCUnits(input.amount)
    const [state, status, keys] = await Promise.all([
      phoenix
        .get(`/v1/trader/state/${encodeURIComponent(wallet)}`, TraderState)
        .catch((error: unknown) => {
          if (error instanceof PhoenixError && error.code === 'not_found')
            throw new PhoenixError(
              'not_activated',
              'This wallet has no Phoenix account; call phoenix_activate_account first',
            )
          throw error
        }),
      phoenix.get('/v1/view/exchange/status', ExchangeStatus),
      phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
    ])
    if (!status.active || !status.withdrawalsAvailable)
      throw new PhoenixError(
        'market_unavailable',
        'Phoenix is not accepting withdrawals right now',
      )
    const cross = state.snapshot.subaccounts.find(
      (subaccount) => subaccount.subaccountIndex === 0,
    )
    const collateral = BigInt(cross?.collateral ?? 0)
    if (amount > collateral)
      throw new PhoenixError(
        'insufficient_funds',
        `The cross-margin account holds ${usdc(collateral.toString())} USDC of collateral, less than ${usdc(amount.toString())}`,
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
        collateralUsdc: usdc(collateral.toString()),
      },
      warnings: [
        "Withdrawals go through Phoenix's queue and may be delayed or dropped.",
        'Open positions keep their margin; Phoenix rejects a withdrawal that would leave too little.',
      ],
    }
  },
})
