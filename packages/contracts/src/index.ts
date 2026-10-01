import { type } from 'arktype'

export const HealthResponse = type({ status: "'ok'" })
export type HealthResponse = typeof HealthResponse.infer

/** OAuth scopes the LanaTools MCP server grants. */
export const MCP_SCOPES = ['account:read', 'payments:pay'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value)
}

/** The highest spending limit a user can give one client, in micro-USD. */
export const MAX_CLIENT_LIMIT_MICRO_USD = 1_000_000_000 // USD 1,000

/**
 * Parses a decimal USD amount such as "0.01" or "$5" into integer micro-USD.
 * Returns null for anything else, including more than six decimal places.
 */
export function parseUsd(value: string): number | null {
  const match = /^\$?(\d{1,7})(?:\.(\d{1,6}))?$/.exec(value.trim())
  if (!match) return null
  const [, whole = '0', fraction = ''] = match
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
}

/** Whether a micro-USD amount is a spending limit a client can have. */
export function isClientLimit(value: number | null): value is number {
  return (
    value !== null &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_CLIENT_LIMIT_MICRO_USD
  )
}

/** Parses a USD spending limit into micro-USD, or null if it is not one. */
export function parseClientLimit(value: string): number | null {
  const limit = parseUsd(value)
  return isClientLimit(limit) ? limit : null
}

/** Formats micro-USD as dollars, keeping cents and any smaller digits. */
export function formatUsd(microUsd: number) {
  const whole = Math.trunc(microUsd / 1_000_000)
  const fraction = String(Math.abs(microUsd % 1_000_000))
    .padStart(6, '0')
    .replace(/0{1,4}$/, '')
  return `$${whole.toLocaleString('en-US')}.${fraction.padEnd(2, '0')}`
}

export const McpClient = type({
  grantId: 'string',
  clientId: 'string',
  clientName: 'string | null',
  redirectHost: 'string | null',
  scopes: 'string[]',
  connectedAt: 'number',
  lastUsedAt: 'number | null',
  limitMicroUsd: 'number',
  spentMicroUsd: 'number',
  reservedMicroUsd: 'number',
})
export type McpClient = typeof McpClient.infer

export const McpClientList = type({ clients: McpClient.array() })
export type McpClientList = typeof McpClientList.infer

export const ClientLimitUpdate = type({ limitUsd: 'string' })
export type ClientLimitUpdate = typeof ClientLimitUpdate.infer

/** Whether LanaTools may sign agent payments from the user's wallet. */
export const PaymentSignerStatus = type({
  status: "'none' | 'pending' | 'enabled' | 'disabled'",
  walletAddress: 'string | null',
})
export type PaymentSignerStatus = typeof PaymentSignerStatus.infer

export const PaymentSignerRequest = type({ walletAddress: 'string' })
export type PaymentSignerRequest = typeof PaymentSignerRequest.infer

/** What the browser passes to Privy's addSigners for the payment signer. */
export const PaymentSignerGrant = type({
  signerId: 'string',
  policyIds: 'string[]',
})
export type PaymentSignerGrant = typeof PaymentSignerGrant.infer
