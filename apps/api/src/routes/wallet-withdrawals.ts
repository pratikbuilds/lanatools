import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { address, createSolanaRpc, isAddress } from '@solana/kit'
import { WithdrawalRequest, WithdrawalTransaction } from '@lanatools/contracts'
import type { WithdrawalReceipt } from '@lanatools/contracts'
import type { McpEnv } from '../mcp-service'
import { paymentConfig } from '../solana/network'
import {
  TransferError,
  prepareUsdcTransfer,
  sendUsdcTransfer,
} from '../solana/usdc-transfer'
import { privyAuth } from './privy-auth'

/**
 * Withdrawals from the payment wallet, in two steps around the user's own
 * signature: `prepare` builds the transfer and `send` broadcasts the signed
 * one. The RPC is checked against the network before either, as for
 * payments; the server never signs.
 */
export const walletWithdrawals = new Hono<{
  Bindings: McpEnv
  Variables: { userId: string }
}>()
  .use(privyAuth)
  .post('/prepare', async (c) => {
    const body = WithdrawalRequest(await c.req.json().catch(() => null))
    if (
      body instanceof type.errors ||
      !isAddress(body.owner) ||
      !isAddress(body.to)
    )
      throw new HTTPException(400)
    const { network, rpcUrl } = await paymentConfig(c.env)
    return withUserErrors(async () =>
      c.json({
        transaction: await prepareUsdcTransfer(createSolanaRpc(rpcUrl), {
          owner: address(body.owner),
          to: address(body.to),
          amount: BigInt(body.amount),
          mint: address(network.usdcMint),
        }),
      } satisfies WithdrawalTransaction),
    )
  })
  .post('/send', async (c) => {
    const body = WithdrawalTransaction(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    const { rpcUrl } = await paymentConfig(c.env)
    return withUserErrors(async () =>
      c.json(
        (await sendUsdcTransfer(
          createSolanaRpc(rpcUrl),
          body.transaction,
        )) satisfies WithdrawalReceipt,
      ),
    )
  })

/** A refusal the user can act on is a 409 with its reason; the rest is 502. */
async function withUserErrors(handle: () => Promise<Response>) {
  try {
    return await handle()
  } catch (error) {
    if (error instanceof TransferError)
      return Response.json({ error: error.message }, { status: 409 })
    // RPC errors can include the RPC URL and its provider key.
    throw new HTTPException(502)
  }
}
