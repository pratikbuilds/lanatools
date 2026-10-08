import { afterEach, describe, expect, mock, test } from 'bun:test'
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { getBase64Decoder } from '@solana/kit'
import type { PreparedTransaction } from '@lanatools/contracts'
import {
  prepareTransactionLink,
  sendTransactionLink,
  signPreparedTransaction,
  TransactionLinkError,
} from './transaction-links'

const originalFetch = globalThis.fetch
function mockFetch(
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
) {
  globalThis.fetch = Object.assign(mock(fn), {
    preconnect: originalFetch.preconnect,
  })
}
const signer = Keypair.generate()
const candidate = new VersionedTransaction(
  new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [],
  }).compileToV0Message(),
)
const prepared: PreparedTransaction = {
  transaction: getBase64Decoder().decode(candidate.serialize()),
  account: signer.publicKey.toBase58(),
  network: 'devnet',
  review: {
    title: 'Test operation',
    description: 'Exact terms',
    actionLabel: 'Continue',
    fields: [],
  },
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: '1234',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('transaction link signing boundary', () => {
  test('wallet only signs; identical signed bytes are explicitly sent and retried through API', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const signed = await signPreparedTransaction(
      prepared,
      prepared.account,
      async (transaction) => {
        transaction.sign([signer])
        return transaction
      },
    )
    expect(signed).not.toBe(prepared.transaction)
    mockFetch(async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      expect(init?.credentials).toBe('omit')
      return new Response(
        JSON.stringify({
          ...prepared,
          id: 'link',
          tool: 'test',
          status: 'unknown',
          signature: 'signature',
          receipt: null,
          createdAt: 1,
          expiresAt: 2,
        }),
      )
    })
    await sendTransactionLink('link', signed)
    await sendTransactionLink('link', signed)
    expect(calls).toEqual([
      {
        url: '/api/transaction-links/link/send',
        body: { transaction: signed },
      },
      {
        url: '/api/transaction-links/link/send',
        body: { transaction: signed },
      },
    ])
  })

  test('rejects missing capability, wrong account, modified message and missing signature', async () => {
    await expect(
      signPreparedTransaction(prepared, prepared.account, undefined),
    ).rejects.toThrow('cannot sign without sending')
    const sign = mock(async (transaction: VersionedTransaction) => transaction)
    await expect(
      signPreparedTransaction(
        prepared,
        Keypair.generate().publicKey.toBase58(),
        sign,
      ),
    ).rejects.toThrow('Connect the wallet')
    expect(sign).not.toHaveBeenCalled()
    await expect(
      signPreparedTransaction(prepared, prepared.account, sign),
    ).rejects.toThrow('did not return a signed')
    await expect(
      signPreparedTransaction(
        prepared,
        prepared.account,
        async (transaction) => {
          transaction.message.recentBlockhash =
            Keypair.generate().publicKey.toBase58()
          transaction.sign([signer])
          return transaction
        },
      ),
    ).rejects.toThrow('changed the prepared transaction')
  })

  test('preparation sends only account and validates the response', async () => {
    mockFetch(async (input, init) => {
      expect(String(input)).toBe('/api/transaction-links/link%2Fid/transaction')
      expect(JSON.parse(String(init?.body))).toEqual({
        account: prepared.account,
      })
      return new Response(JSON.stringify(prepared))
    })
    expect(await prepareTransactionLink('link/id', prepared.account)).toEqual(
      prepared,
    )
  })

  test('retains server retryability and treats lost responses as uncertain', async () => {
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'transaction_expired',
              message: 'Signing request expired.',
              retryable: true,
            },
          }),
          { status: 409 },
        ),
    )
    try {
      await sendTransactionLink('link', 'signed')
      throw new Error('expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionLinkError)
      expect(error).toMatchObject({
        code: 'transaction_expired',
        message: 'Signing request expired.',
        retryable: true,
      })
    }
    mockFetch(async () => {
      throw new Error('network lost')
    })
    await expect(sendTransactionLink('link', 'signed')).rejects.toMatchObject({
      retryable: true,
    })
  })
})
