/** The hosted Surfpool sandbox that `pay --sandbox` settles on. */
export const SANDBOX_RPC_URL = 'https://402.surfnet.dev:8899'
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

async function rpc<T>(method: string, params: Array<unknown>) {
  const res = await fetch(SANDBOX_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result as T
}

interface TokenBalance {
  owner: string
  mint: string
  uiTokenAmount: { amount: string }
}

interface ParsedTransaction {
  meta: {
    err: unknown
    preTokenBalances: Array<TokenBalance>
    postTokenBalances: Array<TokenBalance>
  }
}

/** USDC the transaction moved into `owner`'s token accounts, in base units. */
export async function usdcReceived(signature: string, owner: string) {
  // The RPC can lag the gateway's confirmation: try 20 times, 500 ms apart.
  let tx: ParsedTransaction | null = null
  for (let i = 0; i < 20 && !tx; i++) {
    if (i > 0) await Bun.sleep(500)
    tx = await rpc<ParsedTransaction | null>('getTransaction', [
      signature,
      {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      },
    ])
  }
  if (!tx) {
    throw new Error(`transaction ${signature} not found on ${SANDBOX_RPC_URL}`)
  }
  if (tx.meta.err) throw new Error(`transaction ${signature} failed`)
  const total = (balances: Array<TokenBalance>) =>
    balances
      .filter((b) => b.owner === owner && b.mint === USDC_MINT)
      .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n)
  return total(tx.meta.postTokenBalances) - total(tx.meta.preTokenBalances)
}
