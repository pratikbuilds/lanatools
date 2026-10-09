/**
 * Creates the LanaTools transaction signer: a P-256 authorization key and a
 * Privy key quorum that holds its public key. It signs embedded transactions
 * under its own policy, separate from the payment signer. Run once per Privy
 * app, then store both values as Worker secrets. The private key is printed
 * once and never stored by this script.
 *
 *   bun --env-file=.env apps/api/scripts/create-transaction-signer.ts
 */
import { PrivyClient, generateP256KeyPair } from '@privy-io/node'

const appId = process.env.PRIVY_APP_ID
const appSecret = process.env.PRIVY_APP_SECRET
if (!appId || !appSecret)
  throw new Error('Set PRIVY_APP_ID and PRIVY_APP_SECRET')

const key = await generateP256KeyPair()
const quorum = await new PrivyClient({ appId, appSecret }).keyQuorums().create({
  display_name: 'LanaTools transaction signer',
  public_keys: [key.publicKey],
  authorization_threshold: 1,
})
console.log(`PRIVY_TRANSACTION_SIGNER_ID=${quorum.id}`)
console.log(`PRIVY_TRANSACTION_SIGNER_KEY=${key.privateKey}`)
