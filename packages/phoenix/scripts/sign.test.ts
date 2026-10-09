import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getPublicKeyFromAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signatureBytes,
  verifySignature,
} from '@solana/kit'
import type { Address } from '@solana/kit'
import { expect, test } from 'bun:test'
import { BLOCKHASH, ONBOARDER } from '../src/trade/fixtures'
import { PHOENIX_PROGRAM } from '../src/trade/rise'
import { readSigned } from '../src/trade/transaction'
import { sign } from './sign'

/** An unsigned transaction the wallet pays for, maybe with a co-signer. */
function unsigned(wallet: Address, coSigner?: Address) {
  return getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(wallet, message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH, lastValidBlockHeight: 500n },
            message,
          ),
        (message) =>
          appendTransactionMessageInstructions(
            coSigner
              ? [
                  {
                    programAddress: PHOENIX_PROGRAM,
                    accounts: [
                      { address: coSigner, role: AccountRole.READONLY_SIGNER },
                    ],
                  },
                ]
              : [],
            message,
          ),
      ),
    ),
  )
}

test('a trade for the RPC is signed fully and passes the send checks', async () => {
  const signer = await generateKeyPairSigner()
  const transaction = unsigned(signer.address)
  const signed = await sign({ transaction, submit: { via: 'rpc' } }, signer)
  expect(signed.loginSignature).toBeUndefined()
  expect(
    await readSigned(signed.transaction, { prepared: transaction }),
  ).toMatchObject({ blockhash: BLOCKHASH })
})

test('activation is signed by the wallet only, with a valid login signature', async () => {
  const signer = await generateKeyPairSigner()
  const transaction = unsigned(signer.address, ONBOARDER)
  const message = 'Sign in to Phoenix: nonce-1'
  const signed = await sign(
    {
      transaction,
      submit: {
        via: 'phoenix-referral',
        referralCode: '4L2RQ06K',
        recentBlockhash: BLOCKHASH,
        login: { message, nonceId: 'nonce-1' },
      },
    },
    signer,
  )
  // Phoenix's route needs only the wallet's signature; the RPC route would
  // refuse it without the onboarder's.
  await expect(
    readSigned(signed.transaction, { prepared: transaction, complete: false }),
  ).resolves.toMatchObject({ blockhash: BLOCKHASH })
  await expect(
    readSigned(signed.transaction, { prepared: transaction }),
  ).rejects.toMatchObject({ code: 'invalid_input' })

  expect(
    await verifySignature(
      await getPublicKeyFromAddress(signer.address),
      signatureBytes(getBase58Encoder().encode(signed.loginSignature ?? '')),
      new TextEncoder().encode(message),
    ),
  ).toBe(true)
})
