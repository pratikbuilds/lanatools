import {
  OrderFlags,
  SelfTradeBehavior,
  Side,
  baseLots,
  getOnboardTraderDelegatedEncoder,
  getPlaceMarketOrderEncoder,
  getRegisterTraderInstructionEncoder,
  quoteLots,
  ticks,
} from '@ellipsis-labs/rise'
import {
  AccountRole,
  address,
  blockhash,
  getBase58Decoder,
  getBase64Encoder,
} from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import { PHOENIX_PROGRAM } from './rise'
import { ExchangeKeys } from './schemas'
import traderAccount from './fixtures/trader-account.json'
import type { TradeRpc } from './transaction'

/** Test data for the trade tools. Not exported from the package. */

export const WALLET = address('DuyJffWSmNtaauW2UDiULLUeT1J57UQWphUoZCwvvDdm')
export const OTHER = address('2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC')

/**
 * A real `PlaceMarketOrder` built by Rise 0.5.38 on 2026-10-08: sell 0.03 SOL
 * (3 lots) with a $100.50 limit (10050 ticks), all-or-nothing, expiring at
 * slot 123, reduce-only.
 */
export const MARKET_ORDER_DATA = Uint8Array.from(
  Buffer.from(
    '5a76c0fcc0632791' +
      '020101422700000000000003000000000000000003000000000000000100000000000000000000000000000000000000000000000000017b000000000000008000',
    'hex',
  ),
)

type OrderFields = {
  buy?: boolean
  priceInTicks?: bigint | null
  lots?: bigint
  minLots?: bigint
  lastValidSlot?: bigint | null
  reduceOnly?: boolean
}

/** Market order data encoded by Rise: by default buy 10 lots, partial fills. */
export function marketOrderData(fields: OrderFields = {}) {
  const {
    buy = true,
    priceInTicks = 11573n,
    lots = 10n,
    minLots = 1n,
    lastValidSlot = 1_000n,
    reduceOnly = false,
  } = fields
  return Uint8Array.from(
    getPlaceMarketOrderEncoder().encode({
      side: buy ? Side.Bid : Side.Ask,
      priceInTicks: priceInTicks === null ? null : ticks(priceInTicks),
      numBaseLots: baseLots(lots),
      numQuoteLots: null,
      minBaseLotsToFill: baseLots(minLots),
      minQuoteLotsToFill: quoteLots(1n),
      selfTradeBehavior: SelfTradeBehavior.Abort,
      matchLimit: null,
      clientOrderId: 0n,
      lastValidSlot,
      orderFlags: reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None,
      cancelExisting: false,
    }),
  )
}

/** A Phoenix instruction the wallet signs, with the given data. */
export function phoenixInstruction(
  data: Uint8Array = new Uint8Array(8),
  {
    program = PHOENIX_PROGRAM,
    signers = [WALLET],
  }: { program?: Address; signers?: readonly Address[] } = {},
): Instruction {
  return {
    programAddress: program,
    accounts: [
      { address: PHOENIX_PROGRAM, role: AccountRole.READONLY },
      ...signers.map((signer) => ({
        address: signer,
        role: AccountRole.WRITABLE_SIGNER,
      })),
    ],
    data,
  }
}

export const BLOCKHASH = blockhash(
  getBase58Decoder().decode(new Uint8Array(32).fill(7)),
)

/** GET /v1/view/exchange/keys on 2026-10-08. */
export const KEYS = ExchangeKeys.parse({
  globalConfig: '2zskx2iyCvb6Stg7RBZkt1f6MrF4dpYtMG3yMvKwqtUZ',
  canonicalMint: 'PhUsd11YkbjSaWjFncfAAmatntsjx3MgDR9B6g1ks3A',
  globalVault: 'csZXgw2G58hbiWc9ndxaxrQVYVvqdXgQzYLuznEzHJu',
  perpAssetMap: '2nHGAaEw3D5dd4hVueaUNoygkQFmoeKqRQWnSPqSMFUC',
  withdrawQueue: '3c3NTwpg7yW91FxijkHBXwVH1xUifun3Z8TC5eW5Si3K',
  globalTraderIndex: ['HCrPXLByGqRh2szQi3gj7oRdRVBNi1gccAyn4CQCT3HK'],
  activeTraderBuffer: ['2U32rSzzrQS3eVmGHsnbw5kcqKF3wQXpHGd3hMq5YJok'],
})

/** GET /v1/referral/activation-permission on 2026-10-08. */
export const PERMISSION = {
  trader_onboarder: 'EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z',
  risk_authority: '8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR',
  permission_account: '6UCimUpRW2CGh3ESJm3S59c4WcCaVLYcpPPbbrfX2nzr',
}
export const ONBOARDER = address(PERMISSION.trader_onboarder)

/** A real, activated trader account (the wallet `WALLET`'s). */
export const TRADER_ACCOUNT_DATA = Uint8Array.from(
  getBase64Encoder().encode(traderAccount.data),
)

/** An RPC `getAccountInfo` value in base64. */
export function accountInfo(
  owner: Address,
  data: Uint8Array,
  lamports = 1_000_000n,
) {
  return {
    value: {
      owner,
      lamports,
      data: [Buffer.from(data).toString('base64'), 'base64'],
      executable: false,
      rentEpoch: 0n,
      space: BigInt(data.length),
    },
  }
}

/** An SPL token account holding `amount` base units. */
export function tokenAccountData(amount: bigint) {
  const data = new Uint8Array(165)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  return data
}

/** An RPC that answers from memory; `calls` records what was asked. */
export function fakeRpc(
  answers: Partial<Record<string, (...args: unknown[]) => unknown>>,
) {
  const calls: Array<[string, unknown[]]> = []
  const rpc = new Proxy(
    {},
    {
      get:
        (_, method: string) =>
        (...args: unknown[]) => ({
          send: async () => {
            calls.push([method, args])
            const answer = answers[method]
            if (!answer) throw new Error(`unexpected RPC call ${method}`)
            return answer(...args)
          },
        }),
    },
  ) as TradeRpc
  return { rpc, calls }
}

type PhoenixRequest = {
  path: string
  method: string
  body: unknown
  authorization: string | null
}

/**
 * Phoenix's API from memory, keyed by path. An answer is a JSON body, or a
 * number for an HTTP error status. `requests` records what was asked.
 */
export function fakePhoenix(
  answers: Record<string, unknown | ((request: PhoenixRequest) => unknown)>,
) {
  const requests: PhoenixRequest[] = []
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const request = {
      path: new URL(url).pathname,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      authorization: headers.get('authorization'),
    }
    requests.push(request)
    if (!(request.path in answers))
      throw new Error(`unexpected Phoenix call ${request.path}`)
    const answer = answers[request.path]
    const body = typeof answer === 'function' ? answer(request) : answer
    return typeof body === 'number'
      ? new Response(null, { status: body })
      : Response.json(body)
  }
  return { fetch, requests }
}

/** `RegisterTrader` data, by default for the cross-margin account. */
export function registerTraderData({
  maxPositions = 128n,
  traderPdaIndex = 0,
  subaccountIndex = 0,
} = {}) {
  return Uint8Array.from(
    getRegisterTraderInstructionEncoder().encode({
      maxPositions,
      traderPdaIndex,
      subaccountIndex,
    }),
  )
}

export const ONBOARD_DATA = Uint8Array.from(
  getOnboardTraderDelegatedEncoder().encode(undefined),
)
