import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { APIError, generateP256KeyPair, PrivyClient } from '@privy-io/node'
import type { PrivyPoliciesService } from '@privy-io/node'
import {
  address,
  appendTransactionMessageInstruction,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  isInstructionWithAccounts,
  isInstructionWithData,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
} from '@solana/kit'
import type {
  BlockhashLifetimeConstraint,
  ReadonlyUint8Array,
  Signature,
  TransactionMessage,
} from '@solana/kit'
import {
  getTransferSolInstruction,
  parseTransferSolInstruction,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system'
import { isPolicyDenial } from './privy-policy-denial'

const rpcUrl = 'http://127.0.0.1:8899'
const transferLamports = 1_000n
const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
const userAccessToken = process.env.PRIVY_USER_ACCESS_TOKEN
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET')
if (!userAccessToken) throw new Error('Set PRIVY_USER_ACCESS_TOKEN')

const rpc = createSolanaRpc(rpcUrl)
await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()

const privy = new PrivyClient({ appId, appSecret })
let userId: string
try {
  userId = (await privy.utils().auth().verifyAccessToken(userAccessToken))
    .user_id
} catch {
  throw new Error('Privy user access token is invalid or expired')
}
const { privateKey, publicKey } = await generateP256KeyPair()
const recipient = getAddressDecoder().decode(
  crypto.getRandomValues(new Uint8Array(32)),
)
console.log('Verified Privy user token')

type TransferRule = Pick<
  Parameters<PrivyPoliciesService['updateRule']>[1],
  'name' | 'method' | 'action' | 'conditions'
>

function transferRule(limit: bigint): TransferRule {
  return {
    name: 'Bounded transfer to test recipient',
    method: 'signTransaction',
    action: 'ALLOW',
    conditions: [
      {
        field_source: 'solana_system_program_instruction',
        field: 'instructionName',
        operator: 'eq',
        value: 'Transfer',
      },
      {
        field_source: 'solana_system_program_instruction',
        field: 'Transfer.to',
        operator: 'eq',
        value: recipient,
      },
      {
        field_source: 'solana_system_program_instruction',
        field: 'Transfer.lamports',
        operator: 'lte',
        value: String(limit),
      },
    ],
  }
}

async function cleanupResource({
  kind,
  id,
  remove,
}: {
  kind: string
  id: string
  remove: () => Promise<unknown>
}) {
  try {
    await remove()
    console.log(`Cleaned up ${kind} ${id}`)
  } catch (error) {
    const detail = error instanceof APIError ? `HTTP ${error.status}` : 'error'
    console.error(`Cleanup failed for ${kind} ${id}: ${detail}`)
    process.exitCode = 1
  }
}

async function confirmSignature(
  signature: Signature,
  lifetime?: BlockhashLifetimeConstraint,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { value } = await rpc
      .getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
      .send()
    const status = value[0]
    if (status?.err)
      throw new Error(`Surfpool rejected transaction ${signature}`)
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    )
      return
    if (
      lifetime &&
      (await rpc.getBlockHeight({ commitment: 'confirmed' }).send()) >
        lifetime.lastValidBlockHeight
    )
      throw new Error(`Surfpool transaction expired ${signature}`)
    await Bun.sleep(200)
  }
  throw new Error(`Surfpool transaction was not confirmed ${signature}`)
}

const policy = await privy.policies().create({
  name: 'ADI-175 local transfer proof',
  version: '1.0',
  chain_type: 'solana',
  owner: { user_id: userId },
  rules: [transferRule(transferLamports)],
})
let quorumId: string | undefined
let walletId: string | undefined
try {
  console.log('Created user-owned policy')
  const rule = policy.rules[0]
  if (!rule) throw new Error('Privy returned a policy without its rule')
  const quorum = await privy.keyQuorums().create({
    display_name: `ADI-175 proof ${randomUUID()}`,
    public_keys: [publicKey],
    authorization_threshold: 1,
  })
  quorumId = quorum.id
  const wallet = await privy.wallets().create({
    chain_type: 'solana',
    owner: { user_id: userId },
    additional_signers: [
      { signer_id: quorum.id, override_policy_ids: [policy.id] },
    ],
    display_name: 'ADI-175 disposable local proof',
  })
  walletId = wallet.id
  console.log('Created user-owned wallet and server signer')
  const payer = address(wallet.address)
  const payerSigner = createNoopSigner(payer)
  const authorization_context = { authorization_private_keys: [privateKey] }

  function transaction(amount: bigint, lifetime: BlockhashLifetimeConstraint) {
    return pipe(
      createTransactionMessage({ version: 'legacy' }),
      (message) => setTransactionMessageFeePayer(payer, message),
      (message) =>
        setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
      (message) =>
        appendTransactionMessageInstruction(
          getTransferSolInstruction({
            source: payerSigner,
            destination: recipient,
            amount,
          }),
          message,
        ),
    )
  }

  function assertSingleBoundedTransfer(
    message: Pick<TransactionMessage, 'instructions'>,
    expectedLamports: bigint,
  ) {
    const instruction = message.instructions[0]
    if (message.instructions.length !== 1 || !instruction)
      throw new Error('Expected exactly one transfer instruction')
    if (
      instruction.programAddress !== SYSTEM_PROGRAM_ADDRESS ||
      !isInstructionWithAccounts(instruction) ||
      !isInstructionWithData(instruction)
    )
      throw new Error('Transaction does not contain a System Program transfer')
    const transfer = parseTransferSolInstruction(instruction)
    if (
      transfer.accounts.source.address !== payer ||
      transfer.accounts.destination.address !== recipient ||
      transfer.data.amount !== expectedLamports
    )
      throw new Error('Transaction does not match the bounded transfer')
  }

  async function verifyPrivySignature(
    signedBase64: string,
    unsignedMessage: ReadonlyUint8Array,
  ) {
    const signed = getTransactionDecoder().decode(
      Buffer.from(signedBase64, 'base64'),
    )
    if (!Buffer.from(signed.messageBytes).equals(Buffer.from(unsignedMessage)))
      throw new Error('Privy changed the transaction message')
    const walletSignature = signed.signatures[payer]
    if (!walletSignature) throw new Error('Privy omitted the wallet signature')
    const walletPublicKey = await crypto.subtle.importKey(
      'raw',
      getAddressEncoder().encode(payer),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    if (
      !(await verifySignature(
        walletPublicKey,
        walletSignature,
        signed.messageBytes,
      ))
    )
      throw new Error('Privy returned an invalid wallet signature')
    return getBase64EncodedWireTransaction(signed)
  }

  const firstLifetime = (
    await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  ).value
  const doubleTransfer = appendTransactionMessageInstructions(
    [
      getTransferSolInstruction({
        source: payerSigner,
        destination: recipient,
        amount: transferLamports,
      }),
    ],
    transaction(transferLamports, firstLifetime),
  )
  assert.throws(
    () => assertSingleBoundedTransfer(doubleTransfer, transferLamports),
    /Expected exactly one transfer instruction/,
  )

  const airdrop = await rpc
    .requestAirdrop(payer, lamports(1_000_000n), { commitment: 'confirmed' })
    .send()
  await confirmSignature(airdrop)
  const payerBefore = (
    await rpc.getBalance(payer, { commitment: 'confirmed' }).send()
  ).value
  const recipientBefore = (
    await rpc.getBalance(recipient, { commitment: 'confirmed' }).send()
  ).value
  const lifetime = (
    await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  ).value
  const intended = transaction(transferLamports, lifetime)
  assertSingleBoundedTransfer(intended, transferLamports)
  const compiled = compileTransaction(intended)
  const signed = await privy
    .wallets()
    .solana()
    .signTransaction(wallet.id, {
      transaction: getBase64EncodedWireTransaction(compiled),
      authorization_context,
    })
  const signedWire = await verifyPrivySignature(
    signed.signed_transaction,
    compiled.messageBytes,
  )

  const signature = await rpc
    .sendTransaction(signedWire, {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()
  await confirmSignature(signature, lifetime)
  const tx = await rpc
    .getTransaction(signature, {
      commitment: 'confirmed',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
    })
    .send()
  if (!tx?.meta || tx.meta.err)
    throw new Error(`Surfpool has no successful transaction ${signature}`)
  const payerAfter = (
    await rpc.getBalance(payer, { commitment: 'confirmed' }).send()
  ).value
  const recipientAfter = (
    await rpc.getBalance(recipient, { commitment: 'confirmed' }).send()
  ).value
  if (recipientAfter - recipientBefore !== transferLamports)
    throw new Error('Recipient balance did not increase by the signed amount')
  if (payerBefore - payerAfter !== transferLamports + tx.meta.fee)
    throw new Error('Payer balance did not decrease by transfer plus fee')
  console.log('Verified Surfpool transfer')

  const deniedLifetime = (
    await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  ).value
  const denied = transaction(transferLamports + 1n, deniedLifetime)
  let policyDenied = false
  try {
    await privy
      .wallets()
      .solana()
      .signTransaction(wallet.id, {
        transaction: getBase64EncodedWireTransaction(
          compileTransaction(denied),
        ),
        authorization_context,
      })
  } catch (error) {
    if (!isPolicyDenial(error)) throw error
    policyDenied = true
  }
  if (!policyDenied)
    throw new Error('Privy signed a transfer above the policy limit')
  console.log('Verified policy signing denial')

  let serverEditDenied = false
  try {
    await privy.policies().updateRule(rule.id, {
      policy_id: policy.id,
      ...transferRule(2_000n),
      authorization_context,
    })
  } catch (error) {
    if (!(error instanceof APIError) || ![401, 403].includes(error.status ?? 0))
      throw error
    serverEditDenied = true
  }
  if (!serverEditDenied)
    throw new Error('Privy let the server key widen the user-owned policy')
  console.log('Verified server policy edit denial')

  const userAuthorization = { user_jwts: [userAccessToken] }
  try {
    await privy.policies().updateRule(rule.id, {
      policy_id: policy.id,
      ...transferRule(2_000n),
      authorization_context: userAuthorization,
    })
  } catch (error) {
    if (
      error instanceof APIError &&
      error.status === 400 &&
      /Invalid JWT token provided/i.test(error.message)
    )
      throw new Error(
        'Privy rejected the verified user access token during /v1/wallets/authenticate',
      )
    throw error
  }
  const editedAmount = transferLamports + 1n
  const editedLifetime = (
    await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  ).value
  const editedTransaction = transaction(editedAmount, editedLifetime)
  assertSingleBoundedTransfer(editedTransaction, editedAmount)
  const editedCompiled = compileTransaction(editedTransaction)
  const editedSignature = await privy
    .wallets()
    .solana()
    .signTransaction(wallet.id, {
      transaction: getBase64EncodedWireTransaction(editedCompiled),
      authorization_context,
    })
  await verifyPrivySignature(
    editedSignature.signed_transaction,
    editedCompiled.messageBytes,
  )

  await privy.policies().updateRule(rule.id, {
    policy_id: policy.id,
    ...transferRule(500n),
    authorization_context: userAuthorization,
  })
  let tightenedDenied = false
  try {
    await privy
      .wallets()
      .solana()
      .signTransaction(wallet.id, {
        transaction: getBase64EncodedWireTransaction(editedCompiled),
        authorization_context,
      })
  } catch (error) {
    if (!isPolicyDenial(error)) throw error
    tightenedDenied = true
  }
  if (!tightenedDenied)
    throw new Error('Privy signed above the user-reduced limit')

  console.log(
    JSON.stringify(
      {
        rpcUrl,
        walletId: wallet.id,
        walletAddress: wallet.address,
        userId,
        keyQuorumId: quorum.id,
        policyId: policy.id,
        recipient,
        signature,
        slot: Number(tx.slot),
        transferredLamports: Number(recipientAfter - recipientBefore),
        feeLamports: Number(tx.meta.fee),
        policyDenied,
        serverEditDenied,
        userIncreaseApplied: true,
        userDecreaseApplied: tightenedDenied,
        doubleTransferDeniedLocally: true,
      },
      null,
      2,
    ),
  )
} finally {
  const walletToArchive = walletId
  if (walletToArchive)
    await cleanupResource({
      kind: 'wallet',
      id: walletToArchive,
      remove: () => privy.wallets().archive(walletToArchive),
    })
  const quorumToDelete = quorumId
  if (quorumToDelete)
    await cleanupResource({
      kind: 'key quorum',
      id: quorumToDelete,
      remove: () => privy.keyQuorums().delete(quorumToDelete, {}),
    })
  await cleanupResource({
    kind: 'user-owned policy',
    id: policy.id,
    remove: () =>
      privy.policies().delete(policy.id, {
        authorization_context: { user_jwts: [userAccessToken] },
      }),
  })
}
