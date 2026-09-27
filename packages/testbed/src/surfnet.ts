import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import type { Address } from '@solana/kit'

// Surfpool forks mainnet, so the testbed pays with the mainnet USDC mint.
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

async function call<T>(rpcUrl: string, method: string, params: Array<unknown>) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  })
  const body = (await response.json()) as {
    result?: T
    error?: { message: string }
  }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
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

/** Creates the owner's USDC account if needed and sets its balance. */
export function setUsdc(rpcUrl: string, owner: Address, amount: bigint) {
  return call(rpcUrl, 'surfnet_setTokenAccount', [
    owner,
    USDC_MINT,
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

export async function usdcBalance(rpcUrl: string, owner: Address) {
  const { value } = await call<TokenAccounts>(
    rpcUrl,
    'getTokenAccountsByOwner',
    [
      owner,
      { mint: USDC_MINT },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
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

/** Waits until Surfpool reports the signature as confirmed without error. */
export async function confirmed(rpcUrl: string, signature: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const { value } = await call<TransactionStatus>(
      rpcUrl,
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: true }],
    )
    const status = value[0]
    if (status?.err)
      throw new Error(`Transaction ${signature} failed on Surfpool`)
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    )
      return
    await Bun.sleep(200)
  }
  throw new Error(`Transaction ${signature} was not confirmed on Surfpool`)
}
