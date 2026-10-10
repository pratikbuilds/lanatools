import type { Address } from '@solana/kit'
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { runHeliusTool } from '@lanatools/helius'
import type { WalletToken } from '@lanatools/contracts'
import { TOKEN_2022_PROGRAM } from './token-transfer'
import type { WithdrawalRpc } from './token-transfer'
import { RPC_TIMEOUT_MS } from './network'

/** Read actual token accounts; metadata availability never determines balances. */
export async function walletTokens(
  rpc: WithdrawalRpc,
  owner: Address,
  rpcUrl: string,
): Promise<WalletToken[]> {
  const accounts = await Promise.all(
    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM].map((programId) =>
      rpc
        .getTokenAccountsByOwner(
          owner,
          { programId },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        )
        .send({ abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) }),
    ),
  )
  const tokens: WalletToken[] = accounts.flatMap(({ value }) =>
    value.flatMap(({ pubkey, account }) => {
      const info = account.data.parsed.info
      if (BigInt(info.tokenAmount.amount) === 0n) return []
      return [
        {
          account: pubkey,
          mint: info.mint,
          program: account.owner,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
          name: null,
          symbol: null,
          image: null,
        },
      ]
    }),
  )
  const ids = [...new Set(tokens.map((token) => token.mint))]
  for (let offset = 0; offset < ids.length; offset += 100) {
    const metadata = await runHeliusTool(
      'get_token_info',
      { ids: ids.slice(offset, offset + 100) },
      { rpcUrl },
    )
    if (!metadata.ok) continue
    const assets = metadata.result.assets as Array<{
      id: string
      name: string | null
      symbol: string | null
      image: string | null
    }>
    for (const token of tokens) {
      const asset = assets.find((item) => item.id === token.mint)
      if (asset)
        Object.assign(token, {
          name: asset.name,
          symbol: asset.symbol,
          image:
            asset.image && /^https?:\/\//.test(asset.image)
              ? asset.image
              : null,
        })
    }
  }
  return tokens
}
