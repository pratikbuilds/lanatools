import {
  ACCOUNT_DISCRIMINANTS,
  Direction,
  OrderFlags,
  SelfTradeBehavior,
  Side,
  StopLossOrderKind,
  baseLots,
  buildCancelConditionalOrderIx,
  buildPlacePositionConditionalOrderIx,
  getOnboardTraderDelegatedEncoder,
  getPlaceMarketOrderEncoder,
  getPlacePostOnlyOrderEncoder,
  getRegisterTraderInstructionEncoder,
  quoteLots,
  ticks,
} from '@ellipsis-labs/rise'
import {
  AccountRole,
  address,
  blockhash,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
} from '@solana/kit'
import type { Address, Instruction } from '@solana/kit'
import {
  PHOENIX_PROGRAM,
  conditionalOrdersAddress,
  decodeBundleStep,
  toInstruction,
  traderAccountAddress,
} from './rise'
import type { PhoenixOrders, TriggerPacket, TriggerRequest } from './rise'
import { ExchangeKeys } from './schemas'
import traderAccount from './fixtures/trader-account.json'
import type { TradeOutcome } from './tool'
import { messageOf } from './transaction'
import type { TradeRpc } from './transaction'

/** Test data for the trade tools. Not exported from the package. */

/** D5's fees: a 20% compute margin, no priority fee. */
export const FEES = { computeUnitMargin: 0.2, microLamportsPerComputeUnit: 0n }

/** A prepared result, or a thrown error naming what came back instead. */
export function ready(outcome: TradeOutcome) {
  if (!outcome.ok || outcome.result.status !== 'ready')
    throw new Error(`unexpected ${JSON.stringify(outcome)}`)
  return outcome.result
}

/** The kind of Phoenix step an instruction is, or null. */
export const stepKind = (instruction: Pick<Instruction, 'data'>) =>
  decodeBundleStep(Uint8Array.from(instruction.data ?? []))?.kind ?? null

/** A ready result's Phoenix instructions, without the compute budget. */
export const phoenixSteps = (outcome: TradeOutcome) =>
  messageOf(ready(outcome).transaction).instructions.filter(
    (instruction) => instruction.programAddress === PHOENIX_PROGRAM,
  )

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
  selfTradeBehavior?: SelfTradeBehavior
  cancelExisting?: boolean
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
    selfTradeBehavior = SelfTradeBehavior.Abort,
    cancelExisting = false,
  } = fields
  return Uint8Array.from(
    getPlaceMarketOrderEncoder().encode({
      side: buy ? Side.Bid : Side.Ask,
      priceInTicks: priceInTicks === null ? null : ticks(priceInTicks),
      numBaseLots: baseLots(lots),
      numQuoteLots: null,
      minBaseLotsToFill: baseLots(minLots),
      minQuoteLotsToFill: quoteLots(1n),
      selfTradeBehavior,
      matchLimit: null,
      clientOrderId: 0n,
      lastValidSlot,
      orderFlags: reduceOnly ? OrderFlags.ReduceOnly : OrderFlags.None,
      cancelExisting,
    }),
  )
}

/** Post-only order data encoded by Rise: by default buy 10 lots at 11573. */
export function postOnlyData({ slide = false } = {}) {
  return Uint8Array.from(
    getPlacePostOnlyOrderEncoder().encode({
      side: Side.Bid,
      priceInTicks: ticks(11573n),
      numBaseLots: baseLots(10n),
      clientOrderId: 0n,
      slide,
      lastValidSlot: null,
      orderFlags: OrderFlags.None,
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

/** GET /v1/collateral/assets on 2026-11-01, trimmed. */
export const COLLATERAL_ASSETS = {
  assets: [
    { assetIndex: 4294967295, symbol: 'USDC', decimals: 6 },
    {
      assetIndex: 4294901760,
      symbol: 'SOL',
      decimals: 9,
      spot: {
        isActive: true,
        maxPerTraderBalance: '1000000000000',
        maxGlobalBalance: '50000000000000',
        currGlobalBalance: '9549963151032',
        minMarginDiscountBps: 2000,
        maxMarginDiscountBps: 2000,
      },
    },
  ],
}

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

/**
 * The same account registered but not activated: its capability flags
 * (u32 at byte 96) without the can-deposit bit (16).
 */
export const REGISTERED_TRADER_ACCOUNT_DATA = (() => {
  const data = TRADER_ACCOUNT_DATA.slice()
  data[96] = (data[96] ?? 0) & ~16
  return data
})()

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

/**
 * An RPC for a prepared trade: these accounts are Phoenix's, the blockhash
 * is fixed and every simulation succeeds, using `unitsConsumed`.
 */
export function readyRpc(
  accounts: ReadonlyMap<string, Uint8Array>,
  unitsConsumed: bigint,
) {
  return fakeRpc({
    getSlot: () => 1_000n,
    getAccountInfo: (account) => {
      const data = accounts.get(String(account))
      return data ? accountInfo(PHOENIX_PROGRAM, data) : { value: null }
    },
    getLatestBlockhash: () => ({
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
    }),
    simulateTransaction: () => ({
      value: { err: null, unitsConsumed, logs: [] },
    }),
  })
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

/** GET /v1/view/exchange/market/SOL on 2026-10-08, trimmed. */
export const SOL_MARKET = {
  symbol: 'SOL',
  assetId: 0,
  marketStatus: 'active',
  marketPubkey: '71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2',
  splinePubkey: 'EVhkquLbfm5rDRXtZu9FoyDSXX5mYq2EYU6yD8zfKEqM',
  tickSize: 100,
  baseLotsDecimals: 2,
  takerFee: 0.00035,
  makerFee: 0.00005,
  isolatedOnly: false,
}

/** A SOL book whose best bid is 115.15 and best ask 115.16. */
export const SOL_BOOK = {
  symbol: 'SOL',
  mid: 115.155,
  bids: [
    [115.15, 87.59],
    [115.1, 386.37],
  ],
  asks: [
    [115.2, 284.43],
    [115.16, 157.09],
  ],
}

/** One slot of `conditionalAccountData`; a missing leg is inactive. */
export type FakeSlot = {
  slot: number
  assetId?: number
  sizeBaseLots?: bigint
  sizePercent?: number
  greater?: Omit<TriggerPacket, 'triggerDirection'> | undefined
  less?: Omit<TriggerPacket, 'triggerDirection'> | undefined
}

const HEADER_BYTES = 96
const ORDER_BYTES = 112
function writeLeg(
  view: DataView,
  offset: number,
  leg: FakeSlot['greater'],
  greater: boolean,
) {
  if (!leg) return
  view.setBigUint64(offset, leg.triggerPriceInTicks, true)
  view.setBigUint64(offset + 8, leg.executionPriceInTicks, true)
  view.setUint8(
    offset + 17,
    0x01 |
      (greater ? 0x02 : 0) |
      (leg.side === 'buy' ? 0x04 : 0) |
      (leg.orderKind === 'limit' ? 0x08 : 0),
  )
}

/** A TP/SL account's bytes, in the layout Rise's decoder reads. */
export function conditionalAccountData(
  trader: Address,
  slots: readonly FakeSlot[],
  capacity = Math.max(8, ...slots.map((each) => each.slot + 1)),
) {
  const bytes = new Uint8Array(HEADER_BYTES + capacity * ORDER_BYTES)
  bytes.set(ACCOUNT_DISCRIMINANTS.CONDITIONAL_ORDER_COLLECTION ?? [], 0)
  bytes.set(getAddressEncoder().encode(trader), 8)
  const view = new DataView(bytes.buffer)
  view.setUint8(88, slots.length)
  view.setUint8(89, capacity)
  for (const each of slots) {
    const start = HEADER_BYTES + each.slot * ORDER_BYTES
    view.setBigUint64(start + 24, each.sizeBaseLots ?? 0n, true)
    view.setUint32(start + 56, each.assetId ?? 0, true)
    if (each.sizePercent !== undefined) {
      view.setUint8(start + 60, 0x01)
      view.setUint8(start + 61, each.sizePercent)
    }
    writeLeg(view, start + 64, each.greater, true)
    writeLeg(view, start + 88, each.less, false)
  }
  return bytes
}

const riseLeg = (trigger: TriggerRequest, direction: Direction) => ({
  triggerDirection: direction,
  tradeSide: trigger.side === 'buy' ? Side.Bid : Side.Ask,
  orderKind:
    trigger.orderKind === 'limit'
      ? StopLossOrderKind.Limit
      : StopLossOrderKind.IOC,
  triggerPrice: ticks(BigInt(trigger.triggerPriceInTicks ?? 0)),
  executionPrice: ticks(BigInt(trigger.executionPriceInTicks ?? 0)),
})

/**
 * Phoenix's build routes from memory, through Rise's real builders. `calls`
 * records each request; `tamper` changes one before it is built, as a wrong
 * server answer would.
 */
export function fakeOrders({
  tamperPlace = (request) => request,
  tamperCancel = (request) => request,
  isolatedMarket = () => {
    throw new Error('unexpected isolated market order')
  },
  isolatedLimit = () => {
    throw new Error('unexpected isolated limit order')
  },
}: {
  /** Phoenix's isolated order routes, which a test answers with its bundle. */
  isolatedMarket?: PhoenixOrders['placeIsolatedMarketOrder']
  isolatedLimit?: PhoenixOrders['placeIsolatedLimitOrder']
  tamperPlace?: (
    request: Parameters<PhoenixOrders['placePositionConditionalOrder']>[0],
  ) => Parameters<PhoenixOrders['placePositionConditionalOrder']>[0]
  tamperCancel?: (
    request: Parameters<PhoenixOrders['cancelConditionalOrder']>[0],
  ) => Parameters<PhoenixOrders['cancelConditionalOrder']>[0]
} = {}) {
  const place: Array<
    Parameters<PhoenixOrders['placePositionConditionalOrder']>[0]
  > = []
  const cancel: Array<Parameters<PhoenixOrders['cancelConditionalOrder']>[0]> =
    []
  const traderOf = (authority: string, subaccount?: number | null) =>
    traderAccountAddress(address(authority), subaccount ?? 0)
  const orders: PhoenixOrders = {
    placeIsolatedMarketOrder: isolatedMarket,
    placeIsolatedLimitOrder: isolatedLimit,
    placePositionConditionalOrder: async (asked) => {
      place.push(asked)
      const request = tamperPlace(asked)
      const trader = await traderOf(
        request.authority,
        request.traderSubaccountIndex,
      )
      return [
        toInstruction(
          buildPlacePositionConditionalOrderIx({
            payer: address(request.authority) as never,
            traderAccount: trader as never,
            perpAssetMap: KEYS.perpAssetMap as never,
            globalTraderIndex: KEYS.globalTraderIndex as never,
            activeTraderBuffer: KEYS.activeTraderBuffer as never,
            orderbook: address(SOL_MARKET.marketPubkey) as never,
            splineCollection: address(SOL_MARKET.splinePubkey) as never,
            traderWallet: address(request.authority) as never,
            traderConditionalOrders: await conditionalOrdersAddress(trader),
            assetId: SOL_MARKET.assetId,
            greaterTriggerOrder: request.greaterTrigger
              ? riseLeg(request.greaterTrigger, Direction.GreaterThan)
              : null,
            lessTriggerOrder: request.lessTrigger
              ? riseLeg(request.lessTrigger, Direction.LessThan)
              : null,
            sizeBaseLots:
              request.numBaseLots === undefined || request.numBaseLots === null
                ? null
                : baseLots(BigInt(request.numBaseLots)),
            sizePercent: request.sizePercent ?? null,
          }),
        ),
      ]
    },
    cancelConditionalOrder: async (asked) => {
      cancel.push(asked)
      const request = tamperCancel(asked)
      const trader = await traderOf(
        request.authority,
        request.traderSubaccountIndex,
      )
      return [
        toInstruction(
          buildCancelConditionalOrderIx({
            traderAccount: trader as never,
            traderWallet: address(request.authority) as never,
            orderbook: address(SOL_MARKET.marketPubkey) as never,
            traderConditionalOrders: await conditionalOrdersAddress(trader),
            conditionalOrderIndex: request.conditionalOrderIndex,
            disableFirst: request.executionDirection === 'greater_than',
            disableSecond: request.executionDirection === 'less_than',
          }),
        ),
      ]
    },
  }
  return { orders, place, cancel }
}
