import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { fromLots, usdc } from '../../units'
import { checkPhoenixBundle } from '../checks'
import { toUSDCUnits } from '../price'
import { addMarginInstructions } from '../rise'
import { ExchangeKeys } from '../schemas'
import { ISOLATED_RISK, defineTradeTool } from '../tool'
import { CollateralAmount } from './deposit'
import {
  MarketSymbol,
  PositionSubaccount,
  crossCollateralIn,
  marginOf,
  marketConfig,
  openPosition,
  perpTrade,
  requireActivated,
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
      subaccount: PositionSubaccount,
      amount: CollateralAmount.describe('USDC to add, as a decimal string'),
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
    const { subaccount, direction, held, book } = await openPosition(
      context,
      wallet,
      market.symbol,
      input.subaccount,
    )
    const cross = crossCollateralIn(book).usdc
    if (subaccount === 0)
      throw new PhoenixError(
        'invalid_input',
        `The ${market.symbol} position is in the cross-margin account, which shares its collateral already; only an isolated position takes added margin`,
      )
    if (amount > cross)
      throw new PhoenixError(
        'insufficient_funds',
        `The cross-margin account holds ${usdc(cross.toString())} USDC of collateral, less than ${usdc(amount.toString())}; add more with phoenix_deposit`,
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

    const size = fromLots(held.toString(), market.baseLotsDecimals)
    const added = usdc(amount.toString())
    return {
      kind: 'instructions',
      wallet,
      instructions,
      summary: `Add ${added} USDC of margin to the isolated ${size} ${market.symbol} ${direction} (subaccount ${subaccount}), from the cross-margin account`,
      details: {
        position: `${direction} ${size}`,
        ...marginOf(subaccount).details,
        collateralUsdc: added,
        crossCollateralUsdc: usdc(cross.toString()),
      },
      trade: perpTrade('add_margin', {
        symbol: market.symbol,
        ...marginOf(subaccount).terms,
        collateralUsdc: added,
      }),
      warnings: [
        ISOLATED_RISK,
        'This margin cannot be taken back out while the position is open.',
      ],
    }
  },
})
