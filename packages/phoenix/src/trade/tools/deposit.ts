import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { usdc } from '../../units'
import { fetchAccount, tokenBalance } from '../chain'
import { checkCollateral } from '../checks'
import { toUSDCUnits } from '../price'
import { depositInstructions, usdcAccountAddress } from '../rise'
import { ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import { requireActivated } from './shared'

/** A USDC amount as the agent types it. */
export const USDCAmount = z
  .string()
  .trim()
  .describe('USDC amount as a decimal string, e.g. "25" or "12.5"')

export const deposit = defineTradeTool({
  name: 'phoenix_deposit',
  title: 'Deposit USDC into Phoenix',
  description: [
    "Prepares a deposit of the wallet's USDC into its Phoenix cross-margin account, as collateral for perps.",
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z.object({ amount: USDCAmount }).strict(),
  async prepare({ phoenix, rpc }, input) {
    const wallet = address(input.wallet)
    const amount = toUSDCUnits(input.amount)
    const [held, keys] = await Promise.all([
      usdcAccountAddress(wallet).then((account) => fetchAccount(rpc, account)),
      phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated({ phoenix, rpc }, wallet),
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
      warnings: [],
    }
  },
})
