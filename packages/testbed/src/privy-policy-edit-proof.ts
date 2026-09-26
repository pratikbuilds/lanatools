import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { APIError, generateP256KeyPair, PrivyClient } from '@privy-io/node'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'

const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET')

const connection = new Connection('http://127.0.0.1:8899', 'confirmed')
await connection.getLatestBlockhash()

const privy = new PrivyClient({ appId, appSecret })
const serverKey = await generateP256KeyPair()
const userKey = await generateP256KeyPair()
const recipient = Keypair.generate().publicKey

function transferRule(limit: number) {
  return {
    name: 'User transfer limit',
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
  } as const
}

const policy = await privy.policies().create({
  name: `ADI-175 user edit ${randomUUID().slice(0, 8)}`,
  version: '1.0',
  chain_type: 'solana',
  owner: { public_key: userKey.publicKey },
  rules: [transferRule(1_000)],
})
const rule = policy.rules[0]
if (!rule) throw new Error('Privy returned a policy without its rule')

const serverQuorum = await privy.keyQuorums().create({
  display_name: `ADI-175 server ${randomUUID().slice(0, 8)}`,
  public_keys: [serverKey.publicKey],
  authorization_threshold: 1,
})
const user = await privy.users().create({
  linked_accounts: [
    { type: 'email', address: `adi175-edit-${randomUUID()}@example.com` },
  ],
})
const wallet = await privy.wallets().create({
  chain_type: 'solana',
  owner: { user_id: user.id },
  additional_signers: [
    { signer_id: serverQuorum.id, override_policy_ids: [policy.id] },
  ],
  display_name: 'ADI-175 disposable policy edit proof',
})
const payer = new PublicKey(wallet.address)

async function canServerSign(amount: number) {
  const { blockhash } = await connection.getLatestBlockhash()
  const transaction = new Transaction({
    feePayer: payer,
    recentBlockhash: blockhash,
  }).add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: recipient,
      lamports: amount,
    }),
  )
  try {
    const signed = await privy
      .wallets()
      .solana()
      .signTransaction(wallet.id, {
        transaction: transaction.serialize({
          requireAllSignatures: false,
          verifySignatures: false,
        }),
        authorization_context: {
          authorization_private_keys: [serverKey.privateKey],
        },
      })
    assert(
      Transaction.from(
        Buffer.from(signed.signed_transaction, 'base64'),
      ).verifySignatures(),
    )
    return true
  } catch (error) {
    if (
      !(error instanceof APIError) ||
      !/policy|denied|not allowed/i.test(error.message)
    )
      throw error
    return false
  }
}

assert.equal(await canServerSign(1_000), true)
assert.equal(await canServerSign(1_001), false)

let serverEditDenied = false
try {
  await privy.policies().updateRule(rule.id, {
    policy_id: policy.id,
    ...transferRule(2_000),
    authorization_context: {
      authorization_private_keys: [serverKey.privateKey],
    },
  })
} catch (error) {
  if (!(error instanceof APIError) || ![401, 403].includes(error.status ?? 0))
    throw error
  serverEditDenied = true
}
assert(
  serverEditDenied,
  'Privy let the server key edit a user-controlled policy',
)
assert.equal(await canServerSign(1_001), false)

await privy.policies().updateRule(rule.id, {
  policy_id: policy.id,
  ...transferRule(2_000),
  authorization_context: { authorization_private_keys: [userKey.privateKey] },
})
assert.equal(await canServerSign(1_001), true)

await privy.policies().updateRule(rule.id, {
  policy_id: policy.id,
  ...transferRule(500),
  authorization_context: { authorization_private_keys: [userKey.privateKey] },
})
assert.equal(await canServerSign(1_001), false)

console.log(
  JSON.stringify(
    {
      policyId: policy.id,
      walletId: wallet.id,
      userId: user.id,
      serverEditDenied,
      userIncreaseApplied: true,
      userDecreaseApplied: true,
      broadcast: false,
    },
    null,
    2,
  ),
)
