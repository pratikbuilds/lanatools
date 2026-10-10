import { type } from 'arktype'

export * from './catalog'

export const HealthResponse = type({ status: "'ok'" })
export type HealthResponse = typeof HealthResponse.infer

export const EarlyAccessEmail = type('string')
  .pipe((email) => email.trim().toLowerCase())
  .to('string.email <= 254')

export const EarlyAccessRequest = type({ email: EarlyAccessEmail })
export const EarlyAccessResponse = type({
  status: "'joined'",
  email: 'string.email <= 254',
})
export type EarlyAccessResponse = typeof EarlyAccessResponse.infer

/**
 * One scope per tool family. The user picks these for each client on the
 * consent screen; the scopes the client requested do not decide them.
 * Catalog and transaction-status tools require only an active connection.
 * `jupiter:read` also covers Jupiter swaps; the name stays so existing grants
 * keep working.
 */
export const TOOL_SCOPES = [
  'helius:read',
  'payments:pay',
  'jupiter:read',
  'phoenix:read',
  'solana:transfer',
] as const
export type ToolScope = (typeof TOOL_SCOPES)[number]

/** Selected on the consent screen until the user changes them. */
export const DEFAULT_TOOL_SCOPES: readonly ToolScope[] = [
  'helius:read',
  'payments:pay',
]

export function isToolScope(value: string): value is ToolScope {
  return (TOOL_SCOPES as readonly string[]).includes(value)
}

/** Every grant has account:read, which lets a client see whose it is. */
export const MCP_SCOPES = ['account:read', ...TOOL_SCOPES] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export function isMcpScope(value: string): value is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(value)
}

/**
 * A grant's scopes for the tool families the user chose, in a fixed order, or
 * null if the choice is not a set of tool families. Choosing none leaves the
 * catalog and transaction-status tools.
 */
export function grantScopes(toolScopes: readonly string[]): McpScope[] | null {
  if (
    new Set(toolScopes).size !== toolScopes.length ||
    !toolScopes.every(isToolScope)
  )
    return null
  return [
    'account:read',
    ...TOOL_SCOPES.filter((scope) => toolScopes.includes(scope)),
  ]
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
  /** Estimated provider credits across this client's tool calls. */
  estimatedCredits: 'number',
})
export type McpClient = typeof McpClient.infer

export const McpClientList = type({ clients: McpClient.array() })
export type McpClientList = typeof McpClientList.infer

export const ClientLimitUpdate = type({ limitUsd: 'string' })
export type ClientLimitUpdate = typeof ClientLimitUpdate.infer

/** Fields shared by payment requests and provider tool calls. */
const ActivityIdentity = type({
  id: 'string',
  clientId: 'string',
  clientName: 'string | null',
  /** False once the user has disconnected the client. */
  connected: 'boolean',
  network: 'string | null',
  /** A recorded failure reason or a safe provider error code. */
  reason: 'string | null',
  createdAt: 'number',
})

/** A completed payment request; unsettled reservations stay out of the feed. */
export const PaymentActivityItem = ActivityIdentity.and({
  kind: "'payment'",
  method: 'string',
  origin: 'string',
  path: 'string',
  protocol: "'mpp' | 'x402' | null",
  outcome: "'paid' | 'free' | 'refused' | 'failed'",
  /** What a paid call settled for; null on every other call. */
  amountMicroUsd: 'number | null',
  signature: 'string | null',
  httpStatus: 'number | null',
})
export type PaymentActivityItem = typeof PaymentActivityItem.infer

/** A provider tool call. Credits are estimates, never a wallet charge. */
export const ToolActivityItem = ActivityIdentity.and({
  kind: "'tool'",
  tool: 'string',
  provider: 'string',
  outcome: "'ok' | 'failed'",
  estimatedCredits: 'number',
  durationMs: 'number',
})
export type ToolActivityItem = typeof ToolActivityItem.infer

export const ActivityItem = PaymentActivityItem.or(ToolActivityItem)
export type ActivityItem = typeof ActivityItem.infer

export const ActivityQuery = type({
  'client?': 'string',
  'outcome?': "'paid' | 'free' | 'refused' | 'failed' | 'ok'",
  'before?': 'string',
})
export type ActivityQuery = typeof ActivityQuery.infer

export const ActivityPage = type({
  items: ActivityItem.array(),
  /** Pass as `before` to read the next, older page; null on the last page. */
  nextCursor: 'string | null',
  /** Over every call the filters select, not only this page. */
  totals: {
    calls: 'number',
    spentMicroUsd: 'number',
    estimatedCredits: 'number',
  },
})
export type ActivityPage = typeof ActivityPage.infer

/** How many days back the dashboard charts calls per day: twelve weeks. */
export const ACTIVITY_CHART_DAYS = 84

export const ActivityDays = type({
  days: type({
    /** A UTC date, `YYYY-MM-DD`. Days without calls are left out. */
    day: 'string',
    calls: 'number',
    spentMicroUsd: 'number',
  }).array(),
})
export type ActivityDays = typeof ActivityDays.infer

/** A token account and optional display metadata; amounts remain exact. */
export const WalletToken = type({
  account: 'string',
  mint: 'string',
  program: 'string',
  amount: 'string.integer',
  decimals: 'number.integer >= 0 & number <= 255',
  name: 'string | null',
  symbol: 'string | null',
  image: 'string | null',
})
export type WalletToken = typeof WalletToken.infer

/**
 * A wallet's balances on the API's network, in base units as decimal strings
 * (lamports and each token's on-chain decimals).
 */
export const WalletBalances = type({
  network: "'devnet' | 'mainnet'",
  sol: 'string.integer',
  usdc: 'string.integer',
  tokens: WalletToken.array(),
})
export type WalletBalances = typeof WalletBalances.infer

/** Whether LanaTools may sign agent payments from the user's wallet. */
export const PaymentSignerStatus = type({
  status: "'none' | 'pending' | 'enabled' | 'disabled'",
  walletAddress: 'string | null',
})
export type PaymentSignerStatus = typeof PaymentSignerStatus.infer

export const PaymentSignerRequest = type({
  walletAddress: 'string',
  /** Set up again after the user removed LanaTools access. */
  'restore?': 'boolean',
})
export type PaymentSignerRequest = typeof PaymentSignerRequest.infer

/**
 * Why the API refused a signer change. `signer-not-attached`: Privy does not
 * show the signer on the wallet with the current policy, so the dashboard may
 * replace a signer Privy holds under another policy.
 */
export const PaymentSignerRefusal = type({
  error: 'string',
  'code?': "'signer-not-attached'",
})
export type PaymentSignerRefusal = typeof PaymentSignerRefusal.infer

/**
 * What the browser passes to Privy's addSigners: the payment signer, and the
 * transaction signer when the deployment has one.
 */
export const PaymentSignerGrant = type({
  signers: type({ signerId: 'string', policyIds: 'string[]' }).array(),
})
export type PaymentSignerGrant = typeof PaymentSignerGrant.infer

/**
 * A token withdrawal from the user's payment wallet to another address, in
 * base units. Use mint "native" for SOL. The API builds the transfer, the user's own
 * wallet signs it in the browser, and the API sends it.
 */
export const WithdrawalRequest = type({
  owner: 'string',
  to: 'string',
  amount: 'string.integer',
  mint: 'string',
  'source?': 'string',
})
export type WithdrawalRequest = typeof WithdrawalRequest.infer

/** A transaction as base64 wire bytes: unsigned when prepared, then signed. */
export const WithdrawalTransaction = type({ transaction: 'string' })
export type WithdrawalTransaction = typeof WithdrawalTransaction.infer

/**
 * The submitted withdrawal. `confirmed` is false when the network accepted
 * it but its status could not be read in time, or the broadcast response was
 * lost. Reconcile this signature before making another transfer.
 */
export const WithdrawalReceipt = type({
  signature: 'string',
  confirmed: 'boolean',
})
export type WithdrawalReceipt = typeof WithdrawalReceipt.infer

/**
 * Fixed intent before preparation; a builder later supplies exact terms. A
 * field's `icon` is an https image URL, such as a token logo.
 */
export const TransactionReview = type({
  title: 'string',
  description: 'string',
  actionLabel: 'string',
  fields: type({
    label: 'string',
    value: 'string',
    'icon?': 'string',
  }).array(),
})
export type TransactionReview = typeof TransactionReview.infer

export const TransactionStatus = type(
  "'open' | 'preparing' | 'ready' | 'transaction_expired' | 'submitting' | 'confirmed' | 'failed' | 'expired' | 'unknown' | 'unavailable'",
)
export type TransactionStatus = typeof TransactionStatus.infer

/** How a prepared transaction is signed: review link, agent wallet or LanaTools wallet. */
export const TRANSACTION_DELIVERIES = ['link', 'local', 'embedded'] as const
export const TransactionDelivery = type.enumerated(...TRANSACTION_DELIVERIES)
export type TransactionDelivery = typeof TransactionDelivery.infer

export const TransactionReceipt = type({
  signature: 'string',
  slot: 'string',
  commitment: "'confirmed' | 'finalized'",
})
export type TransactionReceipt = typeof TransactionReceipt.infer

export const PreparedTransaction = type({
  transaction: 'string',
  account: 'string',
  network: "'mainnet' | 'devnet'",
  review: TransactionReview,
  blockhash: 'string',
  lastValidBlockHeight: 'string',
})
export type PreparedTransaction = typeof PreparedTransaction.infer

/** Public fields only: never creator identity, request keys or stored bytes. */
export const TransactionLink = type({
  id: 'string',
  tool: 'string',
  network: "'mainnet' | 'devnet'",
  review: TransactionReview,
  status: TransactionStatus,
  account: 'string | null',
  signature: 'string | null',
  receipt: TransactionReceipt.or('null'),
  createdAt: 'number',
  expiresAt: 'number',
})
export type TransactionLink = typeof TransactionLink.infer

/**
 * What every transaction tool returns to the agent, in every delivery mode.
 * `reviewUrl` is set for links; `transaction` is the unsigned transaction a
 * local wallet signs while the request is ready.
 */
export const TransactionResult = type({
  id: 'string',
  tool: 'string',
  network: "'mainnet' | 'devnet'",
  delivery: TransactionDelivery,
  status: TransactionStatus,
  review: TransactionReview,
  'reviewUrl?': 'string',
  'transaction?': PreparedTransaction,
  signature: 'string | null',
  receipt: TransactionReceipt.or('null'),
  expiresAt: 'number',
})
export type TransactionResult = typeof TransactionResult.infer
