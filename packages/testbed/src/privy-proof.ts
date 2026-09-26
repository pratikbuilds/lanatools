import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { APIError, generateP256KeyPair, PrivyClient } from '@privy-io/node'
import type { PrivyPoliciesService } from '@privy-io/node'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'

const rpcUrl = 'http://127.0.0.1:8899'
const lamports = 1_000
const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
const userAccessToken = process.env.PRIVY_USER_ACCESS_TOKEN
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET')
if (!userAccessToken) throw new Error('Set PRIVY_USER_ACCESS_TOKEN')

const connection = new Connection(rpcUrl, 'confirmed')
await connection.getLatestBlockhash() // Stop before creating Privy resources if Surfpool is down.

const privy = new PrivyClient({ appId, appSecret })
let userId: string
try {
  userId = (await privy.utils().auth().verifyAccessToken(userAccessToken))
    .user_id
} catch {
  throw new Error('Privy user access token is invalid or expired')
}
const { privateKey, publicKey } = await generateP256KeyPair()
const recipient = Keypair.generate().publicKey
console.log('Verified Privy user token')

type TransferRule = Pick<
  Parameters<PrivyPoliciesService['updateRule']>[1],
  'name' | 'method' | 'action' | 'conditions'
>

function transferRule(limit: number): TransferRule {
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
        value: recipient.toBase58(),
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

const policy = await privy.policies().create({
  name: 'ADI-175 local transfer proof',
  version: '1.0',
  chain_type: 'solana',
  owner: { user_id: userId },
  rules: [transferRule(lamports)],
})
console.log('Created user-owned policy')
const rule = policy.rules[0]
if (!rule) throw new Error('Privy returned a policy without its rule')
const quorum = await privy.keyQuorums().create({
  display_name: `ADI-175 proof ${randomUUID()}`,
  public_keys: [publicKey],
  authorization_threshold: 1,
})
const wallet = await privy.wallets().create({
  chain_type: 'solana',
  owner: { user_id: userId },
  additional_signers: [
    { signer_id: quorum.id, override_policy_ids: [policy.id] },
  ],
  display_name: 'ADI-175 disposable local proof',
})
console.log('Created user-owned wallet and server signer')
const payer = new PublicKey(wallet.address)
const authorization_context = { authorization_private_keys: [privateKey] }

function transaction(
  amount: number,
  destination: PublicKey,
  blockhash: string,
) {
  return new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: destination,
      lamports: amount,
    }),
  )
}

function assertSingleBoundedTransfer(
  tx: Transaction,
  expectedLamports: number,
) {
  const instruction = tx.instructions[0]
  if (tx.instructions.length !== 1 || !instruction)
    throw new Error('Expected exactly one transfer instruction')
  const transfer = SystemInstruction.decodeTransfer(instruction)
  if (
    !transfer.fromPubkey.equals(payer) ||
    !transfer.toPubkey.equals(recipient) ||
    transfer.lamports !== BigInt(expectedLamports)
  )
    throw new Error('Transaction does not match the bounded transfer')
}

const doubleTransfer = transaction(
  lamports,
  recipient,
  '11111111111111111111111111111111',
).add(
  SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports }),
)
assert.throws(
  () => assertSingleBoundedTransfer(doubleTransfer, lamports),
  /Expected exactly one transfer instruction/,
)

const airdrop = await connection.requestAirdrop(payer, 1_000_000)
await connection.confirmTransaction(airdrop, 'confirmed')
const payerBefore = await connection.getBalance(payer)
const recipientBefore = await connection.getBalance(recipient)
const lifetime = await connection.getLatestBlockhash()
const intended = transaction(lamports, recipient, lifetime.blockhash)
assertSingleBoundedTransfer(intended, lamports)
const unsigned = intended.serialize({
  requireAllSignatures: false,
  verifySignatures: false,
})
const signed = await privy.wallets().solana().signTransaction(wallet.id, {
  transaction: unsigned,
  authorization_context,
})
const wire = Buffer.from(signed.signed_transaction, 'base64')
if (!Transaction.from(wire).verifySignatures())
  throw new Error(
    'Privy returned a transaction without a valid wallet signature',
  )

const signature = await connection.sendRawTransaction(wire)
const confirmation = await connection.confirmTransaction(
  { signature, ...lifetime },
  'confirmed',
)
if (confirmation.value.err)
  throw new Error(`Surfpool rejected transaction ${signature}`)
const tx = await connection.getTransaction(signature, {
  commitment: 'confirmed',
})
if (!tx?.meta || tx.meta.err)
  throw new Error(`Surfpool has no successful transaction ${signature}`)
const payerAfter = await connection.getBalance(payer)
const recipientAfter = await connection.getBalance(recipient)
if (recipientAfter - recipientBefore !== lamports)
  throw new Error('Recipient balance did not increase by the signed amount')
if (payerBefore - payerAfter !== lamports + tx.meta.fee)
  throw new Error('Payer balance did not decrease by transfer plus fee')
console.log('Verified Surfpool transfer')

const denied = transaction(
  lamports + 1,
  recipient,
  (await connection.getLatestBlockhash()).blockhash,
)
let policyDenied = false
try {
  await privy
    .wallets()
    .solana()
    .signTransaction(wallet.id, {
      transaction: denied.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
      authorization_context,
    })
} catch (error) {
  if (
    !(error instanceof APIError) ||
    !/policy|denied|not allowed/i.test(error.message)
  )
    throw error
  policyDenied = true
}
if (!policyDenied)
  throw new Error('Privy signed a transfer above the policy limit')
console.log('Verified policy signing denial')

let serverEditDenied = false
try {
  await privy.policies().updateRule(rule.id, {
    policy_id: policy.id,
    ...transferRule(2_000),
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
    ...transferRule(2_000),
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
const editedAmount = lamports + 1
const editedTransaction = transaction(
  editedAmount,
  recipient,
  (await connection.getLatestBlockhash()).blockhash,
)
assertSingleBoundedTransfer(editedTransaction, editedAmount)
const editedSignature = await privy
  .wallets()
  .solana()
  .signTransaction(wallet.id, {
    transaction: editedTransaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }),
    authorization_context,
  })
if (
  !Transaction.from(
    Buffer.from(editedSignature.signed_transaction, 'base64'),
  ).verifySignatures()
)
  throw new Error('Privy returned an invalid signature after the user edit')

await privy.policies().updateRule(rule.id, {
  policy_id: policy.id,
  ...transferRule(500),
  authorization_context: userAuthorization,
})
let tightenedDenied = false
try {
  await privy
    .wallets()
    .solana()
    .signTransaction(wallet.id, {
      transaction: editedTransaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      }),
      authorization_context,
    })
} catch (error) {
  if (
    !(error instanceof APIError) ||
    !/policy|denied|not allowed/i.test(error.message)
  )
    throw error
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
      recipient: recipient.toBase58(),
      signature,
      slot: tx.slot,
      transferredLamports: recipientAfter - recipientBefore,
      feeLamports: tx.meta.fee,
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
