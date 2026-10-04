# DAS holdings and token information

`get_wallet_holdings` and `get_token_info` each make one Helius DAS request.
The normal successful request costs 10 credits. They do not fetch off-chain
metadata URLs or send transactions. Asset names and symbols are untrusted data;
they do not establish authenticity. Verify the mint address and cluster.

## Wallet holdings

Input: `owner`, `include` (`tokens` by default, `nfts`, or `all`), `hide_zero`
(true by default), `limit` (20 by default; 1–100), and an optional upstream
`cursor`. The request uses `getAssetsByOwner`, deterministic ID sorting, and
`displayOptions.showFungible`, `showNativeBalance`, and `showZeroBalance`.

`sol.amount`, token `amount`, and all raw-unit values are decimal strings,
including amounts above JavaScript's safe-integer limit. Missing balances,
decimals, metadata, programs, and prices are null, never guessed or made zero.
Known zero holdings can be omitted with `hide_zero`; unknown balances remain.

`include` filters the returned page locally because the documented owner request
does not define a token-type filter. Therefore a page can have fewer than `limit`
selected assets, including zero. Follow `next_cursor` even on an empty filtered
page. Keep the owner and other inputs unchanged when continuing. A truly empty
upstream page terminates pagination. A repeated nonempty cursor is an upstream
error rather than an infinite pagination loop.

`nft_count` counts recognized NFT interfaces on the current upstream page, even
when `include` hides NFT detail; `nft_count_scope` is always `page`. Unknown
interfaces are counted separately in `unknown_asset_count` and never silently
classified as NFTs. `page_asset_count` is the size before local filtering.

`total_usd_value` is the known-value subtotal of native SOL and the selected
fungible tokens on this page. It excludes NFTs and missing token prices, and is
null if no component is valued. A known zero balance contributes zero without
requiring a market price. `valuation.scope` is `sol_and_selected_page_tokens`,
`valuation.prices_complete` indicates whether every included balance has a value
(or is known zero), and `valuation.is_portfolio_total` is always false. Do not
sum this subtotal across pages: SOL is repeated on every page. This endpoint
does not claim to calculate a complete portfolio valuation.

## Token information

Input: `ids`, an array of 1–100 mint or asset IDs. A single ID uses `getAsset`;
multiple IDs use `getAssetBatch`. Both request `options.showFungible`.

The result contains `assets` in input order and `not_found`. A successful batch
is matched by asset ID rather than response position, so null entries or omitted
IDs do not shift identities. A whole-batch RPC failure remains an error; it does
not mark every requested ID missing. A single `getAsset` response of null or
its explicit RPC `-32004` not-found code is a missing asset.

`supply` is an exact human-unit decimal string; `raw_supply` preserves the
base-unit integer. The original `token_program` address is retained alongside a
`program` label of `SPL`, `Token-2022`, or null. NFT details include collection
ID and verification state, creators, and compression state when available.

Missing names and symbols are null. Token-2022 on-chain extension metadata can
supply those fields when DAS content metadata is absent. An authority address
has status `present`; an explicit provider null has status `revoked`; an omitted
or otherwise unavailable field has status `unknown`. Neither a null address with
unknown status nor metadata mutability proves mint authority was revoked.

## Prices and fixture provenance

Helius documents `price_info.price_per_token` and `total_price` as USD values
while its sample uses `currency: "USDC"`. The normalizer follows that provider
contract for USD/USDC quotes and preserves `price_currency`; it does not perform
an independent USDC-to-USD conversion. Other or missing quote currencies do not
populate the USD fields. Prices can be cached for up to 600 seconds and are not
available for every asset. No missing value is inferred by multiplying a price
by a balance.

Tests use synthetic, sanitized fixtures shaped after the official response
schemas. The devnet USDC fixture tests its documented six decimals and absent
metadata; it is not a live-network attestation. The Token-2022 fixture uses a
synthetic asset-program association and must not be treated as real token data.

References:

- [DAS pagination](https://www.helius.dev/docs/das/pagination)
- [Fungible owner queries](https://demo.helius.dev/list-wallet-assets/fungible-tokens)
- [Fungible token extension and USD/USDC fields](https://www.helius.dev/docs/das/fungible-token-extension)
- [getAsset](https://www.helius.dev/docs/api-reference/das/getasset)
- [getAssetBatch](https://www.helius.dev/docs/api-reference/das/getassetbatch)
- [Official Helius DAS types](https://github.com/helius-labs/helius-sdk/blob/main/src/types/das.ts)
- [Solana token program addresses](https://solana.com/docs/references/terminology)
