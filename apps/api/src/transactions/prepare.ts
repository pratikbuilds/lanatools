import { type } from 'arktype'
import { createSolanaRpc, getBase64Decoder } from '@solana/kit'
import type { D1Database } from '@cloudflare/workers-types'
import type { GrantIdentity } from '../mcp-grants'
import { PAYMENT_NETWORKS, RPC_TIMEOUT_MS } from '../solana/network'
import type { SolanaEnv } from '../solana/network'
import {
  claimPreparation,
  getRequest,
  getRequestRecord,
  storePrepared,
} from './ledger'
import {
  buildSolTransferMessage,
  validateSolTransferMessage,
} from './sol-transfer'

const Intent = type({
  '+': 'reject',
  version: '1',
  action: "'transfer_sol'",
  execution: "'embedded' | 'external'",
  network: "'devnet' | 'mainnet'",
  recipient: 'string',
  amountLamports: 'string',
  embeddedWallet: { id: 'string', address: 'string' },
  externalWallet: 'string | null',
}).or({
  '+': 'reject',
  version: '1',
  action: "'transfer_sol'",
  execution: "'embedded' | 'external'",
  network: "'devnet' | 'mainnet'",
  recipient: 'string',
  amountLamports: 'string',
  embeddedWallet: 'null',
  externalWallet: 'string | null',
})

export type PreparationRpc = {
  genesisHash: string
  slot: bigint
  blockhash: string
  lastValidBlockHeight: bigint
}
export type PreparationReader = (rpcUrl: string) => Promise<PreparationRpc>

async function readPreparation(rpcUrl: string): Promise<PreparationRpc> {
  const rpc = createSolanaRpc(rpcUrl)
  const genesisHash = await rpc.getGenesisHash().send({
    abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (genesisHash !== PAYMENT_NETWORKS.devnet.genesisHash)
    throw new Error('Not devnet')
  const response = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send({
      abortSignal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
  return { genesisHash, slot: response.context.slot, ...response.value }
}

/** Trusted executor boundary; returns safe progress only after durable storage. */
export async function prepareSolTransfer(
  db: D1Database,
  identity: GrantIdentity,
  requestId: string,
  env: SolanaEnv,
  readRpc: PreparationReader = readPreparation,
) {
  const request = await getRequestRecord(db, identity, requestId)
  const intent = Intent.assert(JSON.parse(request.canonicalInput))
  if (
    env.SOLANA_NETWORK !== 'devnet' ||
    request.network !== 'devnet' ||
    intent.network !== request.network ||
    !env.SOLANA_RPC_URL
  )
    throw new Error('SOL preparation requires configured devnet RPC')
  if (!request.walletAddress)
    throw new Error('Select the external wallet before preparing')
  if (
    intent.execution !== request.execution ||
    (request.execution === 'embedded' &&
      intent.embeddedWallet?.address !== request.walletAddress) ||
    (request.execution === 'external' &&
      intent.externalWallet !== null &&
      intent.externalWallet !== request.walletAddress)
  )
    throw new Error('Stored SOL source does not match the request')
  const claim = await claimPreparation(db, identity, requestId)
  if (!claim) return getRequest(db, identity, requestId)
  let rpc: PreparationRpc
  try {
    rpc = await readRpc(env.SOLANA_RPC_URL)
  } catch {
    // RPC errors can contain provider credentials. Preserve the durable claim.
    throw new Error('Could not prepare the Solana devnet transaction')
  }
  if (
    rpc.genesisHash !== PAYMENT_NETWORKS.devnet.genesisHash ||
    rpc.slot < 0n ||
    rpc.lastValidBlockHeight <= 0n
  )
    throw new Error('Invalid devnet preparation evidence')
  const expected = {
    walletAddress: request.walletAddress,
    recipient: intent.recipient,
    amountLamports: intent.amountLamports,
    blockhash: rpc.blockhash,
    lastValidBlockHeight: rpc.lastValidBlockHeight,
  }
  const message = buildSolTransferMessage(expected)
  validateSolTransferMessage(message, expected)
  await storePrepared(db, identity, claim, {
    walletAddress: request.walletAddress,
    network: 'devnet',
    messageBase64: getBase64Decoder().decode(message),
    preparationSlot: rpc.slot.toString(),
    blockhash: rpc.blockhash,
    lastValidBlockHeight: rpc.lastValidBlockHeight.toString(),
  })
  return getRequest(db, identity, requestId)
}
