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
import { usdcAccount } from '../solana/usdc-transfer'
import { privyAuth } from './privy-auth'

/**
 * Reads a wallet's SOL and USDC balances for the dashboard, so the browser
 * never needs an RPC URL and the provider key in it stays on the server.
 * USDC is read from the wallet's associated token account, the one a
 * withdrawal spends from, so what the dashboard shows can be withdrawn.
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
    try {
      const [balance, held] = await Promise.all([
        rpc
          .getBalance(address(owner), { commitment: 'confirmed' })
          .send(options),
        usdcAccount(
          address(owner),
          address(PAYMENT_NETWORKS[network.name].usdcMint),
        ).then((account) =>
          fetchMaybeToken(rpc, account, {
            ...options,
            commitment: 'confirmed',
          }),
        ),
      ])
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
    } satisfies WalletBalances)
  })
