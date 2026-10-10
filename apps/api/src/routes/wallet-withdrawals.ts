import { type } from 'arktype'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { address, createSolanaRpc, isAddress } from '@solana/kit'
import { fetchMaybeToken } from '@solana-program/token'
import { WithdrawalRequest, WithdrawalTransaction } from '@lanatools/contracts'
import type { WithdrawalReceipt } from '@lanatools/contracts'
import { privyClient } from '../mcp-service'
import type { McpEnv } from '../mcp-service'
import { findUserWallet } from '../payments/signer-setup'
import { RPC_TIMEOUT_MS, paymentConfig } from '../solana/network'
import {
  TransferError,
  prepareTokenTransfer,
  readSignedWithdrawal,
  sendWithdrawal,
} from '../solana/token-transfer'
import type {
  WithdrawalRpc,
  WithdrawalTransfer,
} from '../solana/token-transfer'
import {
  recordWithdrawal,
  settleWalletTransfer,
} from '../transactions/wallet-transfers'
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
    const { network, rpcUrl } = await paymentConfig(c.env)
    return withUserErrors(async () => {
      const withdrawal = await readSignedWithdrawal(body.transaction)
      const userId = c.get('userId')
      await assertOwnWallet(c.env, userId, withdrawal.payer)
      const rpc = createSolanaRpc(rpcUrl)
      // The ledger row is written before the relay so the Transactions tab
      // lists the withdrawal at once. Recording must never block the send.
      const recorded = await recordWithdrawal(c.env.DB, {
        userId,
        wallet: withdrawal.payer,
        network: network.name,
        mint: withdrawal.transfer.mint,
        decimals: withdrawal.transfer.decimals,
        amount: withdrawal.transfer.amount,
        counterparty: await recipientOf(rpc, withdrawal.transfer),
        signature: withdrawal.signature,
      })
        .then(() => true)
        .catch(() => {
          // D1 may include bound values in its errors. Log a fixed line.
          console.error('Could not record withdrawal')
          return false
        })
      const settle = (status: 'confirmed' | 'failed') =>
        recorded
          ? settleWalletTransfer(c.env.DB, {
              userId,
              signature: withdrawal.signature,
              status,
            }).catch(() => console.error('Could not settle withdrawal'))
          : Promise.resolve()
      let receipt: WithdrawalReceipt
      try {
        receipt = await sendWithdrawal(rpc, withdrawal)
      } catch (error) {
        // Only a refusal the cluster gave is final; anything else may land.
        if (error instanceof TransferError) await settle('failed')
        throw error
      }
      if (receipt.confirmed) await settle('confirmed')
      return c.json(receipt satisfies WithdrawalReceipt)
    })
  })

/**
 * The wallet a withdrawal pays. A token goes to a token account; when the
 * transaction did not create it, its owner is read from the chain, and the
 * account itself stands in if that read fails.
 */
async function recipientOf(rpc: WithdrawalRpc, transfer: WithdrawalTransfer) {
  if (transfer.recipient) return transfer.recipient
  try {
    const account = await fetchMaybeToken(rpc, transfer.destination, {
      abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      commitment: 'confirmed',
    })
    return account.exists ? account.data.owner : transfer.destination
  } catch {
    return transfer.destination
  }
}

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
