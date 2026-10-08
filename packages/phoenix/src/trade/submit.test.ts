import {
  AccountRole,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { expect, test } from 'bun:test'
import { BLOCKHASH, ONBOARDER, fakePhoenix, fakeRpc } from './fixtures'
import { PHOENIX_PROGRAM } from './rise'
import { submitSignedTransaction } from './submit'
import type { Submit } from './tool'

const REFERRAL: Submit = {
  via: 'phoenix-referral',
  referralCode: '4L2RQ06K',
  recentBlockhash: BLOCKHASH,
  login: { message: 'Sign in to Phoenix: nonce-1', nonceId: 'nonce-1' },
}

/** An activation-like transaction the wallet signed; the onboarder has not. */
async function walletSigned() {
  const wallet = await generateKeyPairSigner()
  const onboarder = createNoopSigner(ONBOARDER)
  const signed = await partiallySignTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (message) => setTransactionMessageFeePayerSigner(wallet, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
          message,
        ),
      (message) =>
        appendTransactionMessageInstructions(
          [
            {
              programAddress: PHOENIX_PROGRAM,
              accounts: [
                {
                  address: ONBOARDER,
                  role: AccountRole.READONLY_SIGNER,
                  signer: onboarder,
                },
              ],
            },
          ],
          message,
        ),
    ),
  )
  return {
    wallet: wallet.address,
    transaction: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  }
}

const SESSION = { access_token: 'token-1', token_type: 'Bearer' }
const confirmed = () =>
  fakeRpc({
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'confirmed', err: null }],
    }),
  })

test('a referral activation logs in, then Phoenix submits it', async () => {
  const { wallet, transaction, signature } = await walletSigned()
  const phoenix = fakePhoenix({
    '/v1/auth/login/wallet': SESSION,
    '/v1/referral/activate-tx': {
      status: 'submitted',
      signature,
      trader_pda: 'AmNfRQFmWiNB4ia81s3vCykGMAtgyi3k5j1ySUV7W153',
      referral_code: '4L2RQ06K',
    },
  })
  const { rpc, calls } = confirmed()
  expect(
    await submitSignedTransaction(
      { wallet, lastValidBlockHeight: '500', submit: REFERRAL },
      { transaction, loginSignature: 'login-signature' },
      { rpc, fetch: phoenix.fetch, intervalMs: 0 },
    ),
  ).toEqual({ status: 'confirmed', signature })

  expect(phoenix.requests).toEqual([
    {
      path: '/v1/auth/login/wallet',
      method: 'POST',
      body: {
        wallet_pubkey: wallet,
        signature: 'login-signature',
        nonce_id: 'nonce-1',
      },
      authorization: null,
    },
    {
      path: '/v1/referral/activate-tx',
      method: 'POST',
      body: {
        referral_code: '4L2RQ06K',
        trader_authority: wallet,
        trader_pda_index: 0,
        trader_subaccount_index: 0,
        recent_blockhash: BLOCKHASH,
        transaction,
      },
      authorization: 'Bearer token-1',
    },
  ])
  // Phoenix broadcasts; we only watch for confirmation.
  expect(calls.map(([method]) => method)).toEqual(['getSignatureStatuses'])
})

test('without the login signature nothing is sent', async () => {
  const { wallet, transaction } = await walletSigned()
  const phoenix = fakePhoenix({})
  await expect(
    submitSignedTransaction(
      { wallet, lastValidBlockHeight: '500', submit: REFERRAL },
      { transaction },
      { rpc: fakeRpc({}).rpc, fetch: phoenix.fetch },
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' })
  expect(phoenix.requests).toEqual([])
})

test('a failed login sends nothing', async () => {
  const { wallet, transaction, signature } = await walletSigned()
  const phoenix = fakePhoenix({ '/v1/auth/login/wallet': 401 })
  expect(
    await submitSignedTransaction(
      { wallet, lastValidBlockHeight: '500', submit: REFERRAL },
      { transaction, loginSignature: 'bad' },
      { rpc: fakeRpc({}).rpc, fetch: phoenix.fetch },
    ),
  ).toEqual({
    status: 'failed',
    signature,
    error: 'Phoenix login failed (Phoenix answered HTTP 401); nothing was sent',
  })
  expect(phoenix.requests.map((request) => request.path)).toEqual([
    '/v1/auth/login/wallet',
  ])
})

test('a lost answer from Phoenix is unknown: it may have submitted', async () => {
  const { wallet, transaction, signature } = await walletSigned()
  const phoenix = fakePhoenix({
    '/v1/auth/login/wallet': SESSION,
    '/v1/referral/activate-tx': 502,
  })
  expect(
    await submitSignedTransaction(
      { wallet, lastValidBlockHeight: '500', submit: REFERRAL },
      { transaction, loginSignature: 'login-signature' },
      { rpc: fakeRpc({}).rpc, fetch: phoenix.fetch },
    ),
  ).toEqual({
    status: 'unknown',
    signature,
    error:
      'Phoenix did not confirm the submission (Phoenix answered HTTP 502); check the account before trying again',
  })
})

test('Phoenix reporting another state or transaction is never success', async () => {
  const { wallet, transaction, signature } = await walletSigned()
  const answer = (body: Record<string, unknown>) =>
    submitSignedTransaction(
      { wallet, lastValidBlockHeight: '500', submit: REFERRAL },
      { transaction, loginSignature: 'login-signature' },
      {
        rpc: fakeRpc({}).rpc,
        fetch: fakePhoenix({
          '/v1/auth/login/wallet': SESSION,
          '/v1/referral/activate-tx': {
            trader_pda: 'AmNfRQFmWiNB4ia81s3vCykGMAtgyi3k5j1ySUV7W153',
            referral_code: '4L2RQ06K',
            ...body,
          },
        }).fetch,
      },
    )
  expect(await answer({ status: 'already_activated' })).toEqual({
    status: 'failed',
    signature,
    error: 'Phoenix says this account is already activated; nothing was sent',
  })
  expect(
    await answer({ status: 'submitted', signature: 'another-signature' }),
  ).toMatchObject({ status: 'unknown', signature })
})

test('a transaction for the RPC is sent there, and must be fully signed', async () => {
  const { wallet, transaction } = await walletSigned()
  const phoenix = fakePhoenix({})
  // The onboarder has not signed, so the RPC route refuses it.
  await expect(
    submitSignedTransaction(
      { wallet, lastValidBlockHeight: '500', submit: { via: 'rpc' } },
      { transaction },
      { rpc: fakeRpc({}).rpc, fetch: phoenix.fetch },
    ),
  ).rejects.toMatchObject({
    code: 'invalid_input',
    message: 'The transaction is not a fully signed Solana transaction',
  })
  expect(phoenix.requests).toEqual([])
})
