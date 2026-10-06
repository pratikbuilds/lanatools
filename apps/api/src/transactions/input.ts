import { TransactionInput } from '@lanatools/contracts'
import { isAddress } from '@solana/kit'
import { type } from 'arktype'

export type RequestContext = {
  network: 'devnet' | 'mainnet'
  /** Resolved from the authenticated owner's wallet, never from agent input. */
  embeddedWallet: { id: string; address: string } | null
}

export async function hashBytes(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function normalizeInput(input: unknown, context: RequestContext) {
  const parsed = TransactionInput.assert(input)
  if (!isAddress(parsed.recipient)) throw new Error('Invalid recipient')
  const network = type("'devnet' | 'mainnet'").assert(context.network)
  const wallet = parsed.execution === 'embedded' ? context.embeddedWallet : null
  if (
    parsed.execution === 'embedded' &&
    (!wallet?.id || !isAddress(wallet.address))
  )
    throw new Error('Resolve the embedded wallet before creating the request')
  const externalWallet =
    parsed.execution === 'external' ? parsed.externalWallet : null
  if (externalWallet !== null && !isAddress(externalWallet))
    throw new Error('Invalid external wallet')
  const canonicalInput = JSON.stringify({
    version: 1,
    action: parsed.action,
    execution: parsed.execution,
    network,
    recipient: parsed.recipient,
    amountLamports: BigInt(parsed.amountLamports).toString(),
    embeddedWallet: wallet ? { id: wallet.id, address: wallet.address } : null,
    externalWallet,
  })
  return {
    idempotencyKey: parsed.idempotencyKey,
    execution: parsed.execution,
    network,
    walletAddress: wallet?.address ?? externalWallet,
    canonicalInput,
    inputHash: await hashBytes(new TextEncoder().encode(canonicalInput)),
  }
}
