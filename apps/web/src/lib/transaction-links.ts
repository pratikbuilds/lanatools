import { PreparedTransaction, TransactionLink } from '@lanatools/contracts'
import { getBase64Decoder, getBase64Encoder } from '@solana/kit'
import { VersionedTransaction } from '@solana/web3.js'

export class TransactionLinkError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code?: string,
  ) {
    super(message)
  }
}

async function request(
  id: string,
  path = '',
  body?: object,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(
      `/api/transaction-links/${encodeURIComponent(id)}${path}`,
      {
        credentials: 'omit',
        ...(signal ? { signal } : {}),
        ...(body
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }
          : {}),
      },
    )
  } catch (error) {
    if (signal?.aborted) throw error
    throw new TransactionLinkError(
      'Could not reach LanaTools. Try again with the same transaction.',
      true,
    )
  }
  if (!response.ok) {
    const fallback =
      response.status === 404
        ? 'This transaction link could not be found. Check the link and try again.'
        : 'Could not complete this request. Refresh the status and try again.'
    const data: unknown = await response.json().catch(() => null)
    if (
      data &&
      typeof data === 'object' &&
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'message' in data.error &&
      typeof data.error.message === 'string'
    ) {
      throw new TransactionLinkError(
        data.error.message,
        'retryable' in data.error && data.error.retryable === true,
        'code' in data.error && typeof data.error.code === 'string'
          ? data.error.code
          : undefined,
      )
    }
    throw new TransactionLinkError(
      fallback,
      response.status >= 500 || response.status === 429,
    )
  }
  return response.json()
}

export async function getTransactionLink(
  id: string,
  signal?: AbortSignal,
): Promise<TransactionLink> {
  return TransactionLink.assert(await request(id, '', undefined, signal))
}

export async function prepareTransactionLink(
  id: string,
  account: string,
): Promise<PreparedTransaction> {
  return PreparedTransaction.assert(
    await request(id, '/transaction', { account }),
  )
}

export async function sendTransactionLink(
  id: string,
  transaction: string,
): Promise<TransactionLink> {
  return TransactionLink.assert(await request(id, '/send', { transaction }))
}

export async function signPreparedTransaction(
  prepared: PreparedTransaction,
  account: string,
  signTransaction:
    | ((transaction: VersionedTransaction) => Promise<VersionedTransaction>)
    | undefined,
): Promise<string> {
  if (!signTransaction)
    throw new Error(
      'This wallet cannot sign without sending. Choose another wallet.',
    )
  if (account !== prepared.account)
    throw new Error('Connect the wallet used to prepare this transaction.')
  const transaction = VersionedTransaction.deserialize(
    new Uint8Array(getBase64Encoder().encode(prepared.transaction)),
  )
  if (transaction.message.staticAccountKeys[0]?.toBase58() !== account)
    throw new Error('The prepared transaction does not match your wallet.')
  const message = transaction.message.serialize()
  const signed = await signTransaction(transaction)
  const signedMessage = signed.message.serialize()
  if (
    message.length !== signedMessage.length ||
    message.some((byte, index) => byte !== signedMessage[index])
  ) {
    throw new Error(
      'The wallet changed the prepared transaction. It was not submitted.',
    )
  }
  if (!signed.signatures[0]?.some((byte) => byte !== 0))
    throw new Error('The wallet did not return a signed transaction.')
  return getBase64Decoder().decode(signed.serialize())
}
