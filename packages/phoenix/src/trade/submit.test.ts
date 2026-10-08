import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
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
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(wallet, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
        draft,
      ),
    (draft) =>
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
        draft,
      ),
  )
  const signed = await partiallySignTransactionMessageWithSigners(message)
  return {
    wallet: wallet.address,
    prepared: getBase64EncodedWireTransaction(compileTransaction(message)),
    transaction: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  }
}

/** A wallet-only transaction for the RPC route, fully signed. */
async function rpcSigned() {
  const wallet = await generateKeyPairSigner()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(wallet, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
        draft,
      ),
  )
  const signed = await partiallySignTransactionMessageWithSigners(message)
  return {
    wallet: wallet.address,
    prepared: getBase64EncodedWireTransaction(compileTransaction(message)),
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
  const { wallet, prepared, transaction, signature } = await walletSigned()
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
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: REFERRAL,
      },
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
  const { wallet, prepared, transaction } = await walletSigned()
  const phoenix = fakePhoenix({})
  await expect(
    submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: REFERRAL,
      },
      { transaction },
      { rpc: fakeRpc({}).rpc, fetch: phoenix.fetch },
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' })
  expect(phoenix.requests).toEqual([])
})

test('a failed login sends nothing', async () => {
  const { wallet, prepared, transaction, signature } = await walletSigned()
  const phoenix = fakePhoenix({ '/v1/auth/login/wallet': 401 })
  expect(
    await submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: REFERRAL,
      },
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
  const { wallet, prepared, transaction, signature } = await walletSigned()
  const phoenix = fakePhoenix({
    '/v1/auth/login/wallet': SESSION,
    '/v1/referral/activate-tx': 502,
  })
  expect(
    await submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: REFERRAL,
      },
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
  const { wallet, prepared, transaction, signature } = await walletSigned()
  const answer = (body: Record<string, unknown>) =>
    submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: REFERRAL,
      },
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

test('a transaction for the RPC route is sent there once and watched', async () => {
  const { wallet, prepared, transaction, signature } = await rpcSigned()
  const phoenix = fakePhoenix({})
  const { rpc, calls } = fakeRpc({
    sendTransaction: () => signature,
    getSignatureStatuses: () => ({
      value: [{ confirmationStatus: 'confirmed', err: null }],
    }),
  })
  expect(
    await submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: { via: 'rpc' },
      },
      { transaction },
      { rpc, fetch: phoenix.fetch, intervalMs: 0 },
    ),
  ).toEqual({ status: 'confirmed', signature })
  expect(calls.map(([method]) => method)).toEqual([
    'sendTransaction',
    'getSignatureStatuses',
  ])
  expect(phoenix.requests).toEqual([])
})

test('the RPC route needs every signature', async () => {
  const { wallet, prepared, transaction } = await walletSigned()
  // The onboarder has not signed, so the RPC route refuses it.
  await expect(
    submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: { via: 'rpc' },
      },
      { transaction },
      { rpc: fakeRpc({}).rpc, fetch: fakePhoenix({}).fetch },
    ),
  ).rejects.toMatchObject({
    code: 'invalid_input',
    message: 'The transaction is not fully signed; nothing was sent',
  })
})

test('Phoenix is never asked to submit anything but the prepared transaction', async () => {
  const { wallet, prepared } = await walletSigned()
  const other = await walletSigned()
  const phoenix = fakePhoenix({})
  await expect(
    submitSignedTransaction(
      {
        wallet,
        transaction: prepared,
        lastValidBlockHeight: '500',
        submit: REFERRAL,
      },
      { transaction: other.transaction, loginSignature: 'login-signature' },
      { rpc: fakeRpc({}).rpc, fetch: phoenix.fetch },
    ),
  ).rejects.toMatchObject({ code: 'invalid_input' })
  expect(phoenix.requests).toEqual([])
})
