import { afterAll, expect, test } from 'bun:test'
import { generateKeyPairSigner } from '@solana/kit'
import type { KeyPairSigner, TransactionPartialSigner } from '@solana/kit'
import { createPayKit, usd } from '@solana/pay-kit'
import {
  ClientPermissions,
  createPayKitClient,
  PermissionDeniedError,
  usd as usdCap,
} from '@solana/pay-kit/client'

// Nothing listens here: a payment that got past admission would fail to reach
// an RPC, and a denied one never needs it.
const rpcUrl = 'http://127.0.0.1:9'

const operator = await generateKeyPairSigner()
const merchant = await createPayKit({
  accept: ['mpp', 'x402'],
  mpp: { challengeBindingSecret: '0'.repeat(64) },
  network: 'localnet',
  operator: { recipient: operator.address, signer: operator },
  pricing: { fortune: { amount: usd('0.01'), description: 'A fortune' } },
  rpcUrl,
})
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: merchant.fetch('fortune', () => Response.json({ fortune: 'free' })),
})
afterAll(() => server.stop(true))

test.each([undefined, 'mpp', 'x402'] as const)(
  'a payment above the cap is refused before signing (%s)',
  async (protocol) => {
    let signerCalls = 0
    const payer = await generateKeyPairSigner()
    const signer: TransactionPartialSigner = {
      address: payer.address,
      signTransactions: (transactions, config) => {
        signerCalls++
        return payer.signTransactions(transactions, config)
      },
    }
    const client = await createPayKitClient({
      signer: signer as unknown as KeyPairSigner,
      rpcUrl,
      network: 'localnet',
      permissions: ClientPermissions.builder()
        .allowNetwork('localnet')
        .allowOrigin(server.url.origin)
        .maxAmountPerPayment(usdCap('0.005'))
        .build(),
    })

    const denial = await client.fetch(server.url, undefined, protocol).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(denial).toBeInstanceOf(PermissionDeniedError)
    expect(
      (denial as PermissionDeniedError).rejections.map((r) => r.code),
    ).toContain('amount_exceeds_limit')
    expect(signerCalls).toBe(0)
  },
)
