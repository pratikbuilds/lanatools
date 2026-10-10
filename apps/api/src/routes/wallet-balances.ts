import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { address, createSolanaRpc, isAddress } from '@solana/kit'
import { fetchMaybeToken } from '@solana-program/token'
import type { WalletBalances } from '@lanatools/contracts'
import type { McpEnv } from '../mcp-service'
import {
  PAYMENT_NETWORKS,
  RPC_TIMEOUT_MS,
  solanaConfig,
} from '../solana/network'
import { associatedTokenAccount } from '../solana/token-transfer'
import { walletTokens } from '../solana/wallet-tokens'
import { privyAuth } from './privy-auth'

/**
 * Reads a wallet's SOL and token balances for the dashboard, so the browser
 * never needs an RPC URL and the provider key in it stays on the server.
 * USDC is read from the wallet's associated token account, the one a
 * agent payments spend from. The token list includes other owned accounts.
 */
export const walletBalances = new Hono<{
  Bindings: McpEnv
  Variables: { userId: string }
}>()
  .use(privyAuth)
  .get('/', async (c) => {
    const owner = c.req.query('owner')
    if (!owner || !isAddress(owner)) throw new HTTPException(400)
    const { network, rpcUrl } = await solanaConfig(c.env)
    const rpc = createSolanaRpc(rpcUrl)
    const options = { abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS) }
    let sol: bigint
    let usdc: bigint
    let tokens: Awaited<ReturnType<typeof walletTokens>>
    try {
      const [balance, held, holdings] = await Promise.all([
        rpc
          .getBalance(address(owner), { commitment: 'confirmed' })
          .send(options),
        associatedTokenAccount(
          address(owner),
          address(PAYMENT_NETWORKS[network.name].usdcMint),
        ).then((account) =>
          fetchMaybeToken(rpc, account, {
            ...options,
            commitment: 'confirmed',
          }),
        ),
        walletTokens(rpc, address(owner), rpcUrl),
      ])
      tokens = holdings
      for (const token of tokens) {
        if (token.mint === PAYMENT_NETWORKS[network.name].usdcMint) {
          token.name = 'USD Coin'
          token.symbol = 'USDC'
          token.image ??=
            'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
        }
      }
      sol = balance.value
      usdc = held.exists ? held.data.amount : 0n
    } catch {
      // RPC errors can include the RPC URL and its provider key.
      throw new HTTPException(502)
    }
    return c.json({
      network: network.name,
      sol: String(sol),
      usdc: String(usdc),
      tokens,
    } satisfies WalletBalances)
  })
