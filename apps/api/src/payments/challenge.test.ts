import { expect, test } from 'bun:test'
import { ChargeRefusedError, parseFixedCharge } from './challenge'
import type { PaymentNetwork } from '../solana/network'

const MAINNET: PaymentNetwork = {
  name: 'mainnet',
  genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
}
const MERCHANT = 'Du3X3wKN3LHfSbXtX2PW5jhnSHit8j8NSb19VZW6V9mu'

function base64url(value: unknown) {
  return btoa(JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function mpp402(methodDetails: Record<string, unknown>) {
  const request = base64url({
    amount: '2000',
    currency: MAINNET.usdcMint,
    recipient: MERCHANT,
    methodDetails,
  })
  return new Response('', {
    status: 402,
    headers: {
      'www-authenticate': `Payment id="abc", realm="test", method="solana", intent="charge", request="${request}"`,
    },
  })
}

// The shape mainnet catalog merchants such as Blocksize and Birdeye send.
function x402(network: string) {
  const required = btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '2000',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          payTo: '0x0',
        },
        {
          scheme: 'exact',
          network,
          amount: '2000',
          asset: MAINNET.usdcMint,
          payTo: MERCHANT,
        },
      ],
    }),
  )
  return new Response('', {
    status: 402,
    headers: { 'payment-required': required },
  })
}

test('a mainnet x402 charge is picked from among other chains', () => {
  expect(parseFixedCharge(x402(MAINNET.caip2), 'auto', MAINNET)).toEqual({
    protocol: 'x402',
    amount: 2000n,
    mint: MAINNET.usdcMint,
    recipient: MERCHANT,
    network: 'mainnet',
  })
})

test('MPP mainnet charges are accepted whether the network is omitted, mainnet or mainnet-beta', () => {
  for (const details of [
    {},
    { network: 'mainnet' },
    { network: 'mainnet-beta' },
  ])
    expect(parseFixedCharge(mpp402(details), 'mpp', MAINNET).network).toBe(
      'mainnet',
    )
})

test('a devnet charge is refused on mainnet', () => {
  expect(() =>
    parseFixedCharge(mpp402({ network: 'devnet' }), 'mpp', MAINNET),
  ).toThrow(ChargeRefusedError)
  expect(() =>
    parseFixedCharge(
      x402('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
      'x402',
      MAINNET,
    ),
  ).toThrow(ChargeRefusedError)
})
