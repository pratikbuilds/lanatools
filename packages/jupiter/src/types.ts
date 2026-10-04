export type JupiterError = {
  code:
    | 'invalid_input'
    | 'permission_denied'
    | 'upstream_unavailable'
    | 'rate_limited'
  message: string
  retryable: boolean
  retryAfterSeconds?: number
}

export type JupiterResult<T> = {
  source: 'jupiter'
  network: 'mainnet-beta'
  fetchedAt: string
  data: T
  warnings: string[]
}

export type JupiterOutcome<T = JupiterData> =
  { ok: true; result: JupiterResult<T> } | { ok: false; error: JupiterError }

// Provider fields remain optional and new fields pass through unchanged.
export type SwapStats = {
  priceChange?: number | null
  holderChange?: number | null
  liquidityChange?: number | null
  volumeChange?: number | null
  buyVolume?: number | null
  sellVolume?: number | null
  buyOrganicVolume?: number | null
  sellOrganicVolume?: number | null
  numBuys?: number | null
  numSells?: number | null
  numTraders?: number | null
  numOrganicBuyers?: number | null
  numNetBuyers?: number | null
  [field: string]: unknown
}

export type MintInformation = {
  id?: string
  name?: string
  symbol?: string
  decimals?: number
  tokenProgram?: string
  createdAt?: string
  updatedAt?: string
  icon?: string | null
  twitter?: string | null
  telegram?: string | null
  website?: string | null
  discord?: string | null
  instagram?: string | null
  tiktok?: string | null
  otherUrl?: string | null
  dev?: string | null
  mintAuthority?: string | null
  freezeAuthority?: string | null
  circSupply?: number | null
  totalSupply?: number | null
  launchpad?: string | null
  partnerConfig?: string | null
  graduatedPool?: string | null
  graduatedAt?: string | null
  holderCount?: number | null
  fdv?: number | null
  mcap?: number | null
  usdPrice?: number | null
  priceBlockId?: number | null
  liquidity?: number | null
  apy?: { jupEarn?: number; [field: string]: unknown } | null
  firstPool?: {
    id?: string
    createdAt?: string
    [field: string]: unknown
  } | null
  audit?: {
    isSus?: boolean | null
    mintAuthorityDisabled?: boolean | null
    freezeAuthorityDisabled?: boolean | null
    topHoldersPercentage?: number | null
    devBalancePercentage?: number | null
    devMints?: number | null
    [field: string]: unknown
  } | null
  organicScore?: number
  organicScoreLabel?: 'high' | 'medium' | 'low'
  isVerified?: boolean | null
  tags?: string[] | null
  stats5m?: SwapStats | null
  stats1h?: SwapStats | null
  stats6h?: SwapStats | null
  stats24h?: SwapStats | null
  [field: string]: unknown
}

export type VerificationEligibility = {
  tokenExists: boolean
  isVerified: boolean
  canVerify: boolean
  canMetadata: boolean
  verificationError?: string
  metadataError?: string
  [field: string]: unknown
}

export type SearchTokensData = {
  tokens: MintInformation[]
  missingMints: string[]
  verificationEligibility: VerificationEligibility | null
  eligibilityError: JupiterError | null
}

export type DiscoverTokensData = {
  view: 'ranked' | 'tag' | 'recent'
  tokens: MintInformation[]
  pagination: {
    limit: number
    offset: number
    returned: number
    nextOffset: number | null
    upstreamPagination: boolean
  }
}

export type PriceRecord = {
  usdPrice: number
  liquidity: number
  createdAt: string
  decimals: number
  blockId: number | null
  priceChange24h: number | null
  [field: string]: unknown
}

export type PricesData = {
  prices: Record<string, PriceRecord>
  missingMints: string[]
}

export type JupiterData = SearchTokensData | DiscoverTokensData | PricesData
