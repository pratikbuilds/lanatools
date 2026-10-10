import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { address, createSolanaRpc, isAddress } from '@solana/kit'
import { WithdrawalRequest, WithdrawalTransaction } from '@lanatools/contracts'
import type { WithdrawalReceipt } from '@lanatools/contracts'
import { privyClient } from '../mcp-service'
import type { McpEnv } from '../mcp-service'
import { findUserWallet } from '../payments/signer-setup'
import { paymentConfig } from '../solana/network'
import {
  TransferError,
  prepareTokenTransfer,
  readSignedWithdrawal,
  sendWithdrawal,
} from '../solana/token-transfer'
import { privyAuth } from './privy-auth'

/**
 * Withdrawals from the payment wallet, in two steps around the user's own
 * signature: `prepare` builds the transfer and `send` broadcasts the signed
 * one. Both work only on the signed-in user's own wallet, and `send` relays
 * nothing but a checked token withdrawal. The RPC is checked against the
 * network before either, as for payments; the server never signs.
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
      !isAddress(body.to) ||
      (body.mint !== 'native' && !isAddress(body.mint)) ||
      (body.source !== undefined && !isAddress(body.source))
    )
      throw new HTTPException(400)
    const { rpcUrl } = await paymentConfig(c.env)
    return withUserErrors(async () => {
      await assertOwnWallet(c.env, c.get('userId'), body.owner)
      return c.json({
        transaction: await prepareTokenTransfer(createSolanaRpc(rpcUrl), {
          owner: address(body.owner),
          to: address(body.to),
          amount: BigInt(body.amount),
          mint: body.mint === 'native' ? 'native' : address(body.mint),
          ...(body.source ? { source: address(body.source) } : {}),
        }),
      } satisfies WithdrawalTransaction)
    })
  })
  .post('/send', async (c) => {
    const body = WithdrawalTransaction(await c.req.json().catch(() => null))
    if (body instanceof type.errors) throw new HTTPException(400)
    const { rpcUrl } = await paymentConfig(c.env)
    return withUserErrors(async () => {
      const withdrawal = await readSignedWithdrawal(body.transaction)
      await assertOwnWallet(c.env, c.get('userId'), withdrawal.payer)
      return c.json(
        (await sendWithdrawal(
          createSolanaRpc(rpcUrl),
          withdrawal,
        )) satisfies WithdrawalReceipt,
      )
    })
  })

/** Refuses a wallet that Privy does not list as the user's own. */
async function assertOwnWallet(env: McpEnv, userId: string, wallet: string) {
  if (!(await findUserWallet(privyClient(env), userId, wallet)))
    throw new TransferError('That wallet is not your payment wallet')
}

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
