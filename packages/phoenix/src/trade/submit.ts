import type { Address } from '@solana/kit'
import { PhoenixError, createPhoenixClient } from '../client'
import type { PhoenixOpts } from '../client'
import { ActivationResponse, AuthSession } from './schemas'
import {
  readSigned,
  sendSignedTransaction,
  waitForConfirmation,
} from './transaction'
import type { SendResult, TradeRpc } from './transaction'
import type { Submit } from './tool'

/**
 * Sends a signed trade transaction where its tool said it goes: to the RPC,
 * or to Phoenix, which co-signs and submits referral activation. Either way
 * it is sent once and never retried.
 */

export type SubmitOpts = PhoenixOpts & { rpc: TradeRpc; intervalMs?: number }

export type SignedTrade = {
  /** The tool's transaction, signed by the wallet. */
  transaction: string
  /** For `phoenix-referral`: the wallet's base58 signature of the login message. */
  loginSignature?: string
}

export async function submitSignedTransaction(
  prepared: {
    wallet: Address
    /** The unsigned transaction the tool returned. */
    transaction: string
    lastValidBlockHeight: string
    expiresAfterSlot?: string | undefined
    submit: Submit
  },
  signed: SignedTrade,
  opts: SubmitOpts,
): Promise<SendResult> {
  const intervalMs = opts.intervalMs ?? 2_000
  const { submit } = prepared
  if (submit.via === 'rpc')
    return sendSignedTransaction(
      opts.rpc,
      {
        prepared: prepared.transaction,
        transaction: signed.transaction,
        lastValidBlockHeight: prepared.lastValidBlockHeight,
        expiresAfterSlot: prepared.expiresAfterSlot,
      },
      { intervalMs },
    )

  // Phoenix adds its onboarder's signature, so only the wallet's is needed.
  const { wire, signature, blockhash } = await readSigned(signed.transaction, {
    prepared: prepared.transaction,
    complete: false,
  })
  if (!signed.loginSignature)
    throw new PhoenixError(
      'invalid_input',
      "Phoenix activation also needs the wallet's signature of the login message",
    )
  const phoenix = createPhoenixClient(opts)

  let token: string
  try {
    const session = await phoenix.post('/v1/auth/login/wallet', AuthSession, {
      wallet_pubkey: prepared.wallet,
      signature: signed.loginSignature,
      nonce_id: submit.login.nonceId,
    })
    token = session.access_token
  } catch (error) {
    // Nothing was sent: the transaction never left this process.
    return {
      status: 'failed',
      signature,
      error: `Phoenix login failed (${error instanceof PhoenixError ? error.message : 'unexpected error'}); nothing was sent`,
    }
  }

  let response
  try {
    response = await phoenix.post(
      '/v1/referral/activate-tx',
      ActivationResponse,
      {
        referral_code: submit.referralCode,
        trader_authority: prepared.wallet,
        trader_pda_index: 0,
        trader_subaccount_index: 0,
        recent_blockhash: submit.recentBlockhash,
        transaction: wire,
      },
      { token },
    )
  } catch (error) {
    // Phoenix may have submitted it before the answer was lost.
    return {
      status: 'unknown',
      signature,
      error: `Phoenix did not confirm the submission (${error instanceof PhoenixError ? error.message : 'unexpected error'}); check the account before trying again`,
    }
  }
  if (response.status === 'already_activated')
    return {
      status: 'failed',
      signature,
      error: 'Phoenix says this account is already activated; nothing was sent',
    }
  if (response.signature && response.signature !== signature)
    return {
      status: 'unknown',
      signature,
      error:
        'Phoenix reported a different transaction; check the account before trying again',
    }
  return waitForConfirmation(opts.rpc, {
    signature,
    blockhash,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    intervalMs,
  })
}
