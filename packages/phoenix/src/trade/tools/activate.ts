import { address } from '@solana/kit'
import { z } from 'zod'
import { PhoenixError } from '../../client'
import { Wallet } from '../../tool'
import { fromLots } from '../../units'
import { fetchAccount } from '../chain'
import { checkActivation } from '../checks'
import {
  PHOENIX_PROGRAM,
  activationOf,
  activationTransaction,
  traderAccountAddress,
} from '../rise'
import { ActivationPermission, AuthNonce, ExchangeKeys } from '../schemas'
import { defineTradeTool } from '../tool'
import { messageOf, rpcTimeout } from '../transaction'

/** LanaTools' Phoenix referral code; every activation uses it by default. */
export const LANATOOLS_REFERRAL_CODE = '4L2RQ06K'

const SOL_DECIMALS = 9

export const activateAccount = defineTradeTool({
  name: 'phoenix_activate_account',
  title: 'Activate a Phoenix account',
  description: [
    "Prepares the one-time activation of a wallet's Phoenix perps account with a referral code.",
    'The wallet pays the account rent and fee in SOL; Phoenix co-signs and submits it.',
    'The wallet also signs a login message for Phoenix, which moves no funds.',
    'Returns an unsigned transaction and its simulation; nothing is signed or sent.',
  ].join(' '),
  input: z
    .object({
      wallet: Wallet,
      referralCode: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{1,32}$/, 'Expected a Phoenix referral code')
        .optional()
        .describe('Phoenix referral code; defaults to LanaTools’ code'),
    })
    .strict(),
  programs: [PHOENIX_PROGRAM],
  async prepare({ phoenix, rpc }, input) {
    const wallet = address(input.wallet)
    const referralCode = input.referralCode ?? LANATOOLS_REFERRAL_CODE
    const traderAccount = await traderAccountAddress(wallet)
    const [trader, walletAccount] = await Promise.all([
      fetchAccount(rpc, traderAccount),
      fetchAccount(rpc, wallet),
    ])
    if (trader && trader.owner !== PHOENIX_PROGRAM)
      throw new PhoenixError(
        'upstream_error',
        'The Phoenix trader account is owned by another program',
      )
    const status = activationOf(trader?.data ?? null)
    if (status === 'activated')
      return {
        kind: 'nothing_to_do',
        wallet,
        summary: "This wallet's Phoenix account is already activated.",
      }

    const [keys, permission, nonce, { value: latest }] = await Promise.all([
      phoenix.get('/v1/view/exchange/keys', ExchangeKeys),
      phoenix.get('/v1/referral/activation-permission', ActivationPermission),
      phoenix.get('/v1/auth/nonce', AuthNonce, { wallet_pubkey: wallet }),
      // Phoenix's own example uses a finalized blockhash for activation.
      rpc.getLatestBlockhash({ commitment: 'finalized' }).send(rpcTimeout()),
    ])
    const register = status === 'missing'
    const message = messageOf(
      await activationTransaction({
        wallet,
        keys,
        onboarder: permission.trader_onboarder,
        permissionAccount: permission.permission_account,
        referralCode,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        register,
      }),
    )
    checkActivation(message.instructions, { traderAccount, register })

    const sol = walletAccount?.lamports ?? 0n
    return {
      kind: 'transaction',
      wallet,
      transaction: message.wire,
      lastValidBlockHeight: latest.lastValidBlockHeight.toString(),
      coSigners: [address(permission.trader_onboarder)],
      submit: {
        via: 'phoenix-referral',
        referralCode,
        recentBlockhash: latest.blockhash,
        login: { message: nonce.message, nonceId: nonce.nonce_id },
      },
      summary: register
        ? // A mainnet activation (2026-09-23) cost 0.0279 SOL rent.
          `Activate this wallet's Phoenix account with referral code ${referralCode}: a one-time account rent of about 0.028 SOL plus the fee, paid by the wallet`
        : `Finish activating this wallet's Phoenix account with referral code ${referralCode}: the account already exists, so the wallet pays only the fee`,
      details: {
        referralCode,
        traderAccount,
        registers: register ? 'yes' : 'no, already registered',
        walletSol: fromLots(sol.toString(), SOL_DECIMALS),
      },
      warnings: [
        'Phoenix co-signs and submits this transaction; the wallet also signs a login message for Phoenix, which moves no funds.',
        ...(sol === 0n
          ? ['The wallet has no SOL to pay the rent and fee.']
          : []),
      ],
    }
  },
})
