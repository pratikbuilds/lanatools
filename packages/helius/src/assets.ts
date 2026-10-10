import { HeliusError } from './errors'
import { array, decimalAmount, integer, number, record, text } from './format'

const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
const NFT_INTERFACES = new Set([
  'V1_NFT',
  'V1_PRINT',
  'Legacy_NFT',
  'V2_NFT',
  'ProgrammableNFT',
  'MplCoreAsset',
])

function metadataText(value: unknown) {
  const result = text(value)
  return result?.trim() ? result : null
}

export function optionalUnsignedInteger(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const result = integer(value)
  if (result < 0n) throw new HeliusError('upstream_error')
  return result.toString()
}

export function nonNegativeNumber(value: unknown) {
  const result = number(value)
  return result !== null && result >= 0 ? result : null
}

function tokenDecimals(value: unknown) {
  if (value === undefined || value === null) return null
  const result = number(value)
  if (
    result === null ||
    !Number.isInteger(result) ||
    result < 0 ||
    result > 255
  ) {
    throw new HeliusError('upstream_error')
  }
  return result
}

function authority(info: Record<string, unknown>, key: string) {
  const value = info[key]
  const address = metadataText(value)
  return {
    address,
    status: address ? 'present' : value === null ? 'revoked' : 'unknown',
  }
}

export function assetSummary(value: unknown) {
  const asset = record(value)
  const id = metadataText(asset.id)
  if (!id) throw new HeliusError('upstream_error')
  const info = record(asset.token_info)
  const metadata = record(record(asset.content).metadata)
  const extensions = record(record(asset.mint_extensions).metadata)
  const assetInterface = text(asset.interface)
  const kind = ['FungibleToken', 'FungibleAsset'].includes(assetInterface ?? '')
    ? 'token'
    : NFT_INTERFACES.has(assetInterface ?? '')
      ? 'nft'
      : 'unknown'
  const decimals = tokenDecimals(info.decimals)
  const rawSupply = optionalUnsignedInteger(info.supply)
  const tokenProgram = text(info.token_program)
  const priceInfo = record(info.price_info)
  const currency = metadataText(priceInfo.currency)
  // Helius quotes its USD prices in USD or USDC. Never relabel another currency.
  const usdQuote = ['USD', 'USDC'].includes(currency?.toUpperCase() ?? '')
  const mintAuthority = authority(info, 'mint_authority')
  const freezeAuthority = authority(info, 'freeze_authority')
  return {
    id,
    kind,
    interface: assetInterface,
    name: metadataText(metadata.name) ?? metadataText(extensions.name),
    symbol:
      metadataText(info.symbol) ??
      metadataText(metadata.symbol) ??
      metadataText(extensions.symbol),
    image: metadataText(record(record(asset.content).links).image),
    decimals,
    supply:
      rawSupply !== null && decimals !== null
        ? decimalAmount(rawSupply, decimals)
        : null,
    raw_supply: rawSupply,
    usd_price: usdQuote ? nonNegativeNumber(priceInfo.price_per_token) : null,
    price_currency: currency,
    program:
      tokenProgram === SPL_TOKEN_PROGRAM
        ? 'SPL'
        : tokenProgram === TOKEN_2022_PROGRAM
          ? 'Token-2022'
          : null,
    token_program: tokenProgram,
    mint_authority: mintAuthority.address,
    mint_authority_status: mintAuthority.status,
    freeze_authority: freezeAuthority.address,
    freeze_authority_status: freezeAuthority.status,
    mutable: typeof asset.mutable === 'boolean' ? asset.mutable : null,
    ...(kind === 'nft' ? nftDetails(asset) : {}),
  }
}

function nftDetails(asset: Record<string, unknown>) {
  const collection = array(asset.grouping)
    .map(record)
    .find((group) => group.group_key === 'collection')
  const compressed = record(asset.compression).compressed
  return {
    collection: collection
      ? {
          id: text(collection.group_value),
          verified:
            typeof collection.verified === 'boolean'
              ? collection.verified
              : null,
        }
      : null,
    creators: Array.isArray(asset.creators)
      ? asset.creators.map((value) => {
          const creator = record(value)
          return {
            address: text(creator.address),
            share: number(creator.share),
            verified:
              typeof creator.verified === 'boolean' ? creator.verified : null,
          }
        })
      : null,
    compressed: typeof compressed === 'boolean' ? compressed : null,
  }
}

export function tokenHolding(value: unknown) {
  const asset = assetSummary(value)
  const info = record(record(value).token_info)
  const rawAmount = optionalUnsignedInteger(info.balance)
  const priceInfo = record(info.price_info)
  const usdQuote = ['USD', 'USDC'].includes(
    asset.price_currency?.toUpperCase() ?? '',
  )
  return {
    mint: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    amount:
      rawAmount !== null && asset.decimals !== null
        ? decimalAmount(rawAmount, asset.decimals)
        : null,
    raw_amount: rawAmount,
    decimals: asset.decimals,
    program: asset.program,
    token_program: asset.token_program,
    usd_price: asset.usd_price,
    usd_value: usdQuote ? nonNegativeNumber(priceInfo.total_price) : null,
    price_currency: asset.price_currency,
  }
}
