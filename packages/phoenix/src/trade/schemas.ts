import { isAddress } from '@solana/kit'
import { z } from 'zod'

// Phoenix API responses the trade tools read. Only the fields used; unknown
// fields are dropped, not rejected, as in ../schemas.ts.

const Address = z.string().refine((value) => isAddress(value))
const Addresses = z.array(Address).min(1)

/** GET /v1/view/exchange/keys: the exchange accounts every instruction uses. */
export const ExchangeKeys = z.object({
  globalConfig: Address,
  canonicalMint: Address,
  globalVault: Address,
  perpAssetMap: Address,
  withdrawQueue: Address,
  globalTraderIndex: Addresses,
  activeTraderBuffer: Addresses,
})
export type ExchangeKeys = z.infer<typeof ExchangeKeys>

/** GET /v1/view/exchange/status */
export const ExchangeStatus = z.object({
  active: z.boolean(),
  withdrawalsAvailable: z.boolean(),
})

/** GET /v1/referral/activation-permission: who co-signs activation. */
export const ActivationPermission = z.object({
  trader_onboarder: Address,
  permission_account: Address,
})

/** GET /v1/auth/nonce: the message the wallet signs to log in. */
export const AuthNonce = z.object({
  nonce_id: z.string().min(1),
  message: z.string().min(1),
  expires_at: z.string(),
})

/** POST /v1/auth/login/wallet */
export const AuthSession = z.object({ access_token: z.string().min(1) })

/** POST /v1/referral/activate-tx */
export const ActivationResponse = z.object({
  status: z.enum(['activated', 'submitted', 'already_activated']),
  signature: z.string().nullish(),
  trader_pda: z.string(),
})

/** GET /v1/view/exchange/market/{symbol}: what an order needs. */
export const OrderMarket = z.object({
  symbol: z.string(),
  marketStatus: z.string(),
  marketPubkey: Address,
  splinePubkey: Address,
  tickSize: z
    .union([z.number().int().positive(), z.string().regex(/^[1-9]\d*$/)])
    .transform(BigInt),
  baseLotsDecimals: z.number().int(),
  takerFee: z.number().nonnegative(),
  isolatedOnly: z.boolean(),
})
export type OrderMarket = z.infer<typeof OrderMarket>
