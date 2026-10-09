import type { D1Database } from '@cloudflare/workers-types'
import { formatUsd, parseUsd } from '@lanatools/contracts'
import type { PrivyClient } from '@privy-io/node'
import { address } from '@solana/kit'
import {
  AssetPermission,
  ClientPermissions,
  PermissionDeniedError,
  createPayKitClient,
  usd,
} from '@solana/pay-kit/client'
import { authorizeGrant } from '../mcp-grants'
import type { GrantIdentity } from '../mcp-grants'
import { ChargeRefusedError, parseFixedCharge } from './challenge'
import type { FixedCharge, Protocol } from './challenge'
import {
  enabledSigner,
  openReservations,
  recordCall,
  NoLongerOpenError,
  recordSigning,
  release,
  GRANT_REFUSALS,
  reservationRefusal,
  reserve,
  settle,
} from './ledger'
import type { CallTarget } from './ledger'
import type { PaymentConfig } from '../solana/network'
import {
  OutboundRequestError,
  REQUEST_TIMEOUT_MS,
  checkEndpoint,
  readBody,
  requestInit,
} from './outbound'
import type { OutboundInput, ResponseBody } from './outbound'
import {
  PolicyDeniedError,
  asPayKitSigner,
  privyPaymentSigner,
} from './privy-signer'
import { receiptSignature, refusalDetails } from './settlement'

// Pay Kit probes again, then sends the paid request; both share this budget.
const PAYMENT_TIMEOUT_MS = 45_000
// Longer than any `call` tool call (45 s to pay), so a reservation this old
// belongs to a call that has ended.
const RECONCILE_AFTER_MS = 5 * 60_000

export type PayHttpInput = OutboundInput & {
  url: string
  protocol: Protocol | 'auto'
  /** The most the agent agrees to pay for this call, as a decimal USD string. */
  maxUsd: string
}

export type PayHttpResult = ResponseBody & {
  status: number
  contentType: string | null
  payment: {
    state: 'paid'
    protocol: Protocol
    network: string
    mint: string
    amountAtomic: string
    signature: string | null
  } | null
}

/** A refusal or failure the agent should see. Its message is safe to show. */
export class PayHttpError extends Error {
  override readonly name = 'PayHttpError'
}

/** The payment step: one paid request through Pay Kit. */
export type Payer = (request: {
  url: URL
  init: RequestInit
  charge: FixedCharge
  onProgress: (event: unknown) => void
  /** Records the signed transaction before it can leave the Worker. */
  onSigned: (payerSignature: string, blockhash: string) => Promise<void>
}) => Promise<Response>

export type PayHttpDeps = {
  db: D1Database
  config: () => Promise<PaymentConfig>
  /** Makes the payer for the user's wallet. */
  payer: (wallet: { walletId: string; walletAddress: string }) => Payer
  fetch?: typeof fetch
}

/**
 * Calls an endpoint for an agent and pays its fixed 402 charge from the
 * user's wallet within the client's limit. The endpoint's answers are
 * untrusted: they can only name a charge, which must match the network,
 * USDC, the agent's max_usd, and the client's remaining limit.
 */
export async function payHttp(
  deps: PayHttpDeps,
  identity: GrantIdentity,
  input: PayHttpInput,
): Promise<PayHttpResult> {
  // The API is the boundary: check the stored grant before any request. A
  // refused grant records nothing, so a caller cannot write rows for others.
  const access = await authorizeGrant(deps.db, identity, 'payments:pay')
  if (access !== 'active') throw new PayHttpError(GRANT_REFUSALS[access])
  const fetcher = deps.fetch ?? fetch
  const maxAtomic = parseUsd(input.maxUsd)
  if (maxAtomic === null)
    throw new PayHttpError('max_usd must be a USD amount such as "0.05"')
  let url: URL
  let init: RequestInit
  try {
    url = checkEndpoint(input.url)
    init = requestInit(input)
  } catch (error) {
    if (error instanceof OutboundRequestError)
      throw new PayHttpError(error.message)
    throw error
  }
  const target: CallTarget = {
    method: input.method,
    origin: url.origin,
    path: url.pathname,
  }
  const refuse = async (
    message: string,
    details: { charge?: FixedCharge; httpStatus?: number } = {},
  ): Promise<never> => {
    await recordCall(deps.db, identity, target, {
      status: 'refused',
      error: message,
      ...details,
    })
    throw new PayHttpError(message)
  }

  let unpaid: Response
  try {
    unpaid = await fetcher(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    const message = 'Could not reach the endpoint'
    await recordCall(deps.db, identity, target, {
      status: 'failed',
      error: message,
    })
    throw new PayHttpError(message)
  }
  if (unpaid.status !== 402) {
    const result = await unpaidResult(unpaid)
    await recordCall(deps.db, identity, target, {
      status: 'free',
      httpStatus: unpaid.status,
    })
    return result
  }
  await unpaid.body?.cancel().catch(() => undefined)

  const { network } = await deps.config()
  let charge: FixedCharge
  try {
    charge = parseFixedCharge(unpaid, input.protocol, network)
  } catch (error) {
    if (error instanceof ChargeRefusedError)
      return refuse(error.message, { httpStatus: 402 })
    throw error
  }
  if (charge.amount > BigInt(maxAtomic))
    return refuse(
      // One USDC base unit is one micro-USD.
      `This call costs ${formatUsd(Number(charge.amount))}, more than its max_usd of ${formatUsd(maxAtomic)}`,
      { charge, httpStatus: 402 },
    )
  const signer = await enabledSigner(deps.db, identity.userId)
  if (!signer)
    return refuse(
      'Payments are not set up for your wallet. Set them up in the LanaTools dashboard.',
      { charge, httpStatus: 402 },
    )
  await failEndedCalls(deps.db, identity)

  // Nothing is signed before this reservation succeeds.
  const activityId = await reserve(
    deps.db,
    identity,
    signer.walletId,
    target,
    charge,
  )
  if (!activityId)
    return refuse(
      await reservationRefusal(deps.db, identity, signer.walletId),
      {
        charge,
        httpStatus: 402,
      },
    )

  // Set from Pay Kit's progress callback, so held in an object.
  const progress = { signing: false }
  let paid: Response
  try {
    paid = await deps.payer(signer)({
      url,
      init: { ...init, signal: AbortSignal.timeout(PAYMENT_TIMEOUT_MS) },
      charge,
      onSigned: (payerSignature, blockhash) =>
        recordSigning(deps.db, activityId, {
          payerWallet: signer.walletAddress,
          payerSignature,
          blockhash,
        }),
      onProgress: (event) => {
        const update = event as {
          type?: string
          amount?: unknown
          currency?: unknown
          recipient?: unknown
        }
        // Pay Kit reads the challenge again before paying. Refuse, before
        // anything is signed, if it no longer matches what was reserved.
        if (
          update.type === 'challenge' &&
          (update.amount !== String(charge.amount) ||
            update.currency !== charge.mint ||
            update.recipient !== charge.recipient)
        )
          throw new ChargeChangedError()
        if (update.type === 'signing') progress.signing = true
      },
    })
  } catch (error) {
    // Once signing began, a call that ends without an answer may have paid,
    // but only the endpoint's answer counts: it is recorded as failed.
    const refusal = provenUnsigned(error, progress.signing)
    const message =
      refusal ??
      'The endpoint did not answer after the payment was signed, so it may have charged the wallet. The call is not counted against your limit; check the wallet before repeating it.'
    await release(deps.db, activityId, {
      status: 'failed',
      error: refusal ?? `${message} (${errorText(error)})`,
    })
    throw new PayHttpError(message)
  }

  if (!progress.signing) {
    // Pay Kit's own probe was not a 402, so it returned without paying.
    await release(deps.db, activityId, {
      status: 'free',
      httpStatus: paid.status,
    })
    return unpaidResult(paid)
  }

  // The endpoint's answer decides the payment: it served the call, so it
  // was paid, or it did not, so it failed.
  if (!paid.ok) {
    await paid.body?.cancel().catch(() => undefined)
    const { reason, requestId } = refusalDetails(paid)
    const message = [
      `The endpoint answered ${paid.status} after the payment was signed`,
      reason ? `: ${reason}` : '',
      '. The call is not counted against your limit.',
      requestId ? ` Its request ID is ${requestId}.` : '',
    ].join('')
    await release(deps.db, activityId, {
      status: 'failed',
      error: message,
      httpStatus: paid.status,
    })
    throw new PayHttpError(message)
  }

  // The payment is already made, so a body that cannot be read is not an error.
  const body = await readBody(paid).catch((): ResponseBody => ({
    body: '',
    bodyEncoding: 'text',
  }))
  const signature = receiptSignature(paid, charge.protocol)
  await settle(deps.db, activityId, charge.amount, signature, paid.status)

  return {
    status: paid.status,
    contentType: paid.headers.get('content-type'),
    ...body,
    payment: {
      state: 'paid',
      protocol: charge.protocol,
      network: charge.network,
      mint: charge.mint,
      amountAtomic: String(charge.amount),
      signature,
    },
  }
}

/**
 * Closes the client's reservations whose calls have ended without closing
 * them, such as a Worker stopped midway, so they do not hold the limit.
 */
async function failEndedCalls(database: D1Database, identity: GrantIdentity) {
  for (const row of await openReservations(
    database,
    identity,
    Date.now() - RECONCILE_AFTER_MS,
  ))
    await release(database, row.id, {
      status: 'failed',
      error: row.payerSignature
        ? 'The call ended after the payment was signed, so it may have charged the wallet'
        : 'The call ended before anything was signed',
    }).catch((error: unknown) => {
      // Another call may have closed the same row first.
      if (!(error instanceof NoLongerOpenError)) throw error
    })
}

class ChargeChangedError extends Error {
  override readonly name = 'ChargeChangedError'
  constructor() {
    super('The payment request changed before payment; nothing was signed')
  }
}

/**
 * A refusal message when the error proves nothing was signed, or null. Only
 * three cases qualify: Pay Kit refused the terms, the charge changed before
 * signing, or Privy's policy refused to sign. Any other failure after
 * signing began may have paid.
 */
function provenUnsigned(error: unknown, signing: boolean) {
  if (error instanceof PermissionDeniedError)
    return `Pay Kit refused the payment: ${error.rejections.map((r) => r.message).join('; ')}`
  if (hasCause(error, ChargeChangedError))
    return new ChargeChangedError().message
  if (hasCause(error, PolicyDeniedError))
    return 'The wallet policy refused this payment; nothing was signed'
  if (!signing) return `The payment could not be prepared: ${errorText(error)}`
  return null
}

function hasCause(error: unknown, type: new (...args: never[]) => Error) {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof type) return true
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}

async function unpaidResult(response: Response): Promise<PayHttpResult> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    ...(await readBody(response)),
    payment: null,
  }
}

/** The production payer: Pay Kit, signing with the user's Privy wallet. */
export function payKitPayer({
  privy,
  authorizationKey,
  config,
  wallet,
}: {
  privy: PrivyClient
  authorizationKey: string
  config: PaymentConfig
  wallet: { walletId: string; walletAddress: string }
}): Payer {
  return async ({ url, init, charge, onProgress, onSigned }) => {
    const signer = privyPaymentSigner({
      privy,
      walletId: wallet.walletId,
      walletAddress: address(wallet.walletAddress),
      authorizationKey,
      onSigned,
    })
    const client = await createPayKitClient({
      signer: asPayKitSigner(signer),
      rpcUrl: config.rpcUrl,
      network: charge.network,
      accept: [charge.protocol],
      // Pay Kit's own check, before it builds a transaction: this network,
      // this origin, USDC, and no more than the reserved amount.
      permissions: ClientPermissions.builder()
        .onlyNetwork(charge.network)
        .allowOrigin(url.origin)
        .maxAmountPerPayment(usd(usdString(charge.amount)))
        .allowAsset(
          AssetPermission.withCap(charge.network, charge.mint, charge.amount),
        )
        .build(),
      onProgress,
    })
    return client.fetch(url, init, charge.protocol)
  }
}

function usdString(atomic: bigint) {
  return `${atomic / 1_000_000n}.${String(atomic % 1_000_000n).padStart(6, '0')}`
}
