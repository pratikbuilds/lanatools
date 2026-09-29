import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import type { Address } from '@solana/kit'

// Public RPCs, devnet's in particular, rate-limit bursts of balance reads.
const RATE_LIMIT_RETRIES = 5

async function call<T>(rpcUrl: string, method: string, params: Array<unknown>) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    })
    const body = (await response.json().catch(() => ({}))) as {
      result?: T
      error?: { code?: number; message: string }
    }
    const limited =
      response.status === 429 ||
      body.error?.code === 429 ||
      /too many requests/i.test(body.error?.message ?? '')
    if (limited && attempt < RATE_LIMIT_RETRIES) {
      await Bun.sleep(500 * 2 ** attempt)
      continue
    }
    if (body.error) throw new Error(`${method}: ${body.error.message}`)
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
    return body.result as T
  }
}

/** Fails fast unless the RPC is a Surfpool instance with its cheatcodes. */
export async function assertSurfpool(rpcUrl: string) {
  const version = await call<Record<string, string>>(
    rpcUrl,
    'getVersion',
    [],
  ).catch(() => {
    throw new Error(`Surfpool is not reachable at ${rpcUrl}`)
  })
  if (!version['surfnet-version'])
    throw new Error(`${rpcUrl} is not a Surfpool RPC; refusing to fund it`)
}

/** Surfpool cheatcode: creates the owner's token account and sets its balance. */
export function setTokenBalance(
  rpcUrl: string,
  owner: Address,
  mint: string,
  amount: bigint,
) {
  return call(rpcUrl, 'surfnet_setTokenAccount', [
    owner,
    mint,
    { amount: Number(amount), state: 'initialized' },
    TOKEN_PROGRAM_ADDRESS,
  ])
}

type TokenAccounts = {
  value: Array<{
    account: {
      data: { parsed: { info: { tokenAmount: { amount: string } } } }
    }
  }>
}

export async function tokenBalance(
  rpcUrl: string,
  owner: Address,
  mint: string,
) {
  const { value } = await call<TokenAccounts>(
    rpcUrl,
    'getTokenAccountsByOwner',
    [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  )
  return value.reduce(
    (sum, { account }) =>
      sum + BigInt(account.data.parsed.info.tokenAmount.amount),
    0n,
  )
}

export async function solBalance(rpcUrl: string, owner: Address) {
  const { value } = await call<{ value: number }>(rpcUrl, 'getBalance', [
    owner,
    { commitment: 'confirmed' },
  ])
  return BigInt(value)
}

type TransactionStatus = {
  value: Array<{ err: unknown; confirmationStatus: string | null } | null>
}

/** Waits until the RPC reports the signature as confirmed without error. */
export async function confirmed(rpcUrl: string, signature: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { value } = await call<TransactionStatus>(
      rpcUrl,
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
    )
    const status = value[0]
    if (status?.err)
      throw new Error(`Transaction ${signature} failed on ${rpcUrl}`)
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    )
      return
    await Bun.sleep(200)
  }
  throw new Error(`Transaction ${signature} was not confirmed on ${rpcUrl}`)
}

type Balance = {
  owner: string
  mint: string
  uiTokenAmount: { amount: string }
}
type Transaction = {
  meta: {
    err: unknown
    preTokenBalances: Array<Balance>
    postTokenBalances: Array<Balance>
  }
}

/** Token amount one transaction moved into the owner's accounts. */
export async function tokenReceived(
  rpcUrl: string,
  signature: string,
  owner: string,
  mint: string,
) {
  const sum = (balances: Array<Balance>) =>
    balances
      .filter((b) => b.owner === owner && b.mint === mint)
      .reduce((total, b) => total + BigInt(b.uiTokenAmount.amount), 0n)
  // The RPC can lag the gateway: try 20 times, 500 ms apart.
  for (let i = 0; i < 20; i++) {
    const tx = await call<Transaction | null>(rpcUrl, 'getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ])
    if (tx?.meta.err) throw new Error(`Transaction ${signature} failed`)
    if (tx)
      return sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances)
    await Bun.sleep(500)
  }
  throw new Error(`Transaction ${signature} not found on ${rpcUrl}`)
}
