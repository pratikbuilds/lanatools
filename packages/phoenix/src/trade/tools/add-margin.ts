import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots, usdc } from '../../units'
import { checkPhoenixBundle } from '../checks'
import { toUSDCUnits } from '../price'
import { addMarginInstructions } from '../rise'
import { ExchangeKeys } from '../schemas'
import { ISOLATED_RISK, defineTradeTool } from '../tool'
import { USDCAmount } from './deposit'
import {
  MarketSymbol,
  Subaccount,
  marketConfig,
  openPosition,
  perpTrade,
  requireActivated,
  traderAccount,
} from './shared'

export const addIsolatedMargin = defineTradeTool({
  name: 'phoenix_add_isolated_margin',
  title: 'Add margin to an isolated Phoenix position',
  description: [
    'Prepares a move of USDC from the wallet’s Phoenix cross-margin account into one open isolated position, as extra margin.',
    'It cannot be taken back out while the position is open.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  arguments: z
    .object({
      symbol: MarketSymbol,
      subaccount: Subaccount.optional().describe(
        'Subaccount holding the isolated position, from phoenix_get_account. Needed only when the market is open in more than one',
      ),
      amount: USDCAmount,
    })
    .strict(),
  async prepare(context, input) {
    const wallet = address(input.wallet)
    const amount = toUSDCUnits(input.amount)
    const [market, keys] = await Promise.all([
      marketConfig(context, input.symbol),
      context.phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      requireActivated(context, wallet),
    ])
    const [{ subaccount, lots }, cross] = await Promise.all([
      openPosition(context, wallet, market.symbol, input.subaccount),
      traderAccount(context, wallet),
    ])
    if (subaccount === 0)
      throw new PhoenixError(
        'invalid_input',
        `The ${market.symbol} position is in the cross-margin account, which shares its collateral already; only an isolated position takes added margin`,
      )
    if (amount > cross.collateral)
      throw new PhoenixError(
        'insufficient_funds',
        `The cross-margin account holds ${usdc(cross.collateral.toString())} USDC of collateral, less than ${usdc(amount.toString())}; add more with phoenix_deposit`,
      )

    const instructions = await addMarginInstructions(
      wallet,
      keys,
      subaccount,
      amount,
    )
    await checkPhoenixBundle(instructions, {
      wallet,
      keys,
      market,
      subaccount,
      collateralUsdc: amount,
    })

    const direction = lots > 0n ? 'long' : 'short'
    const size = fromLots(
      (lots > 0n ? lots : -lots).toString(),
      market.baseLotsDecimals,
    )
    const added = usdc(amount.toString())
    return {
      kind: 'instructions',
      wallet,
      instructions,
      summary: `Add ${added} USDC of margin to the isolated ${size} ${market.symbol} ${direction} (subaccount ${subaccount}), from the cross-margin account`,
      details: {
        position: `${direction} ${size}`,
        subaccount: String(subaccount),
        collateralUsdc: added,
        crossCollateralUsdc: usdc(cross.collateral.toString()),
      },
      trade: perpTrade('add_margin', {
        symbol: market.symbol,
        marginMode: 'isolated',
        subaccount,
        collateralUsdc: added,
      }),
      warnings: [
        ISOLATED_RISK,
        'This margin cannot be taken back out while the position is open.',
      ],
    }
  },
})
