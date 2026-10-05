import { Challenge } from 'mppx'
import type { PaymentNetwork } from '../solana/network'

export type Protocol = 'mpp' | 'x402'

/** A fixed charge from a live 402 that LanaTools is willing to pay. */
export type FixedCharge = {
  protocol: Protocol
  amount: bigint
  mint: string
  recipient: string
  network: PaymentNetwork['name']
}

/** The 402 asked for something LanaTools will not pay. Nothing was signed. */
export class ChargeRefusedError extends Error {
  override readonly name = 'ChargeRefusedError'
}

/**
 * Reads the payment request of a 402 response. Only fixed charges (MPP
 * `charge`, x402 `exact`) in USDC on the configured network are accepted;
 * everything else in the response is untrusted and ignored.
 */
export function parseFixedCharge(
  response: Response,
  protocol: Protocol | 'auto',
  network: PaymentNetwork,
  now = Date.now(),
): FixedCharge {
  const offersMpp = !!response.headers.get('www-authenticate')
  const offersX402 = !!response.headers.get('payment-required')
  const chosen =
    protocol === 'auto'
      ? offersMpp
        ? 'mpp'
        : offersX402
          ? 'x402'
          : null
      : protocol
  if (!chosen || (chosen === 'mpp' ? !offersMpp : !offersX402))
    throw new ChargeRefusedError(
      protocol === 'auto'
        ? 'The endpoint answered 402 without an MPP or x402 payment request'
        : `The endpoint does not offer ${protocol} payment`,
    )
  return chosen === 'mpp'
    ? mppCharge(response, network, now)
    : x402Charge(response, network)
}

type MppChargeRequest = {
  amount?: unknown
  currency?: unknown
  recipient?: unknown
  splits?: unknown
  methodDetails?: { network?: unknown }
}

function mppCharge(
  response: Response,
  network: PaymentNetwork,
  now: number,
): FixedCharge {
  let challenges: Challenge.Challenge[]
  try {
    challenges = Challenge.fromResponseList(response)
  } catch {
    throw new ChargeRefusedError('The MPP payment request is malformed')
  }
  const solana = challenges.filter((c) => c.method === 'solana')
  const charge = solana.find((c) => c.intent === 'charge')
  if (!charge)
    throw new ChargeRefusedError(
      solana.length
        ? `Only fixed MPP charges are supported, not ${solana.map((c) => c.intent).join(', ')}`
        : 'The MPP payment request is not for Solana',
    )
  if (charge.expires && Date.parse(charge.expires) <= now)
    throw new ChargeRefusedError('The MPP payment request has expired')
  const request = charge.request as MppChargeRequest
  if (Array.isArray(request.splits) && request.splits.length > 0)
    throw new ChargeRefusedError('Split MPP payments are not supported')
  return checked(
    {
      protocol: 'mpp',
      amount: request.amount,
      mint: request.currency,
      recipient: request.recipient,
      network: request.methodDetails?.network ?? 'mainnet',
    },
    network,
  )
}

type X402Requirement = {
  scheme?: unknown
  network?: unknown
  amount?: unknown
  asset?: unknown
  payTo?: unknown
}

function x402Charge(response: Response, network: PaymentNetwork): FixedCharge {
  let accepts: X402Requirement[]
  try {
    const header = response.headers.get('payment-required') ?? ''
    const decoded = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(header), (c) => c.charCodeAt(0)),
      ),
    ) as { accepts?: unknown }
    if (!Array.isArray(decoded.accepts)) throw new Error('No accepts')
    accepts = decoded.accepts as X402Requirement[]
  } catch {
    throw new ChargeRefusedError('The x402 payment request is malformed')
  }
  const exact = accepts.filter((a) => a.scheme === 'exact')
  if (exact.length === 0)
    throw new ChargeRefusedError(
      'Only fixed x402 charges (scheme "exact") are supported',
    )
  // Prefer the option on our network in USDC; otherwise report the first.
  const requirement =
    exact.find(
      (a) => a.network === network.caip2 && a.asset === network.usdcMint,
    ) ?? exact[0]
  return checked(
    {
      protocol: 'x402',
      amount: requirement?.amount,
      mint: requirement?.asset,
      recipient: requirement?.payTo,
      network:
        requirement?.network === network.caip2
          ? network.name
          : requirement?.network,
    },
    network,
  )
}

function checked(
  terms: {
    protocol: Protocol
    amount: unknown
    mint: unknown
    recipient: unknown
    network: unknown
  },
  network: PaymentNetwork,
): FixedCharge {
  if (terms.network !== network.name)
    throw new ChargeRefusedError(
      `The payment request is for ${String(terms.network)}, but LanaTools pays on ${network.name}`,
    )
  if (terms.mint !== network.usdcMint)
    throw new ChargeRefusedError(
      `The payment request is not in ${network.name} USDC (${network.usdcMint})`,
    )
  if (typeof terms.amount !== 'string' || !/^[1-9]\d{0,15}$/.test(terms.amount))
    throw new ChargeRefusedError('The payment amount is not a positive integer')
  if (typeof terms.recipient !== 'string' || !terms.recipient)
    throw new ChargeRefusedError('The payment request has no recipient')
  return {
    protocol: terms.protocol,
    amount: BigInt(terms.amount),
    mint: terms.mint,
    recipient: terms.recipient,
    network: network.name,
  }
}
