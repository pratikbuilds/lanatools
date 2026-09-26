import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { APIError, generateP256KeyPair, PrivyClient } from '@privy-io/node'
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
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET')

const connection = new Connection(rpcUrl, 'confirmed')
await connection.getLatestBlockhash() // Stop before creating Privy resources if Surfpool is down.

const privy = new PrivyClient({ appId, appSecret })
const { privateKey, publicKey } = await generateP256KeyPair()
const recipient = Keypair.generate().publicKey

const policy = await privy.policies().create({
  name: 'ADI-175 local transfer proof',
  version: '1.0',
  chain_type: 'solana',
  rules: [
    {
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
          value: String(lamports),
        },
      ],
    },
  ],
})
const quorum = await privy.keyQuorums().create({
  display_name: `ADI-175 proof ${randomUUID()}`,
  public_keys: [publicKey],
  authorization_threshold: 1,
})
const user = await privy.users().create({
  linked_accounts: [
    { type: 'email', address: `adi175-${randomUUID()}@example.com` },
  ],
})
const wallet = await privy.wallets().create({
  chain_type: 'solana',
  owner: { user_id: user.id },
  additional_signers: [
    { signer_id: quorum.id, override_policy_ids: [policy.id] },
  ],
  display_name: 'ADI-175 disposable local proof',
})
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

function assertSingleBoundedTransfer(tx: Transaction) {
  const instruction = tx.instructions[0]
  if (tx.instructions.length !== 1 || !instruction)
    throw new Error('Expected exactly one transfer instruction')
  const transfer = SystemInstruction.decodeTransfer(instruction)
  if (
    !transfer.fromPubkey.equals(payer) ||
    !transfer.toPubkey.equals(recipient) ||
    transfer.lamports !== BigInt(lamports)
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
  () => assertSingleBoundedTransfer(doubleTransfer),
  /Expected exactly one transfer instruction/,
)

const airdrop = await connection.requestAirdrop(payer, 1_000_000)
await connection.confirmTransaction(airdrop, 'confirmed')
const payerBefore = await connection.getBalance(payer)
const recipientBefore = await connection.getBalance(recipient)
const lifetime = await connection.getLatestBlockhash()
const intended = transaction(lamports, recipient, lifetime.blockhash)
assertSingleBoundedTransfer(intended)
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

console.log(
  JSON.stringify(
    {
      rpcUrl,
      walletId: wallet.id,
      walletAddress: wallet.address,
      userId: user.id,
      keyQuorumId: quorum.id,
      policyId: policy.id,
      recipient: recipient.toBase58(),
      signature,
      slot: tx.slot,
      transferredLamports: recipientAfter - recipientBefore,
      feeLamports: tx.meta.fee,
      policyDenied,
      doubleTransferDeniedLocally: true,
    },
    null,
    2,
  ),
)
