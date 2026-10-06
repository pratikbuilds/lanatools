import { expect, test } from 'bun:test'
import { type } from 'arktype'
import { PAYMENT_NETWORKS } from '../solana/network'
import { buildSolTransferMessage } from './sol-transfer'
import {
  createSolExecutionRpc,
  unsignedSolWire,
  verifySignedSolTransfer,
} from './sol-execution'

const expected = {
  walletAddress: 'So11111111111111111111111111111111111111112',
  recipient: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amountLamports: '9007199254740993',
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 100n,
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const message = buildSolTransferMessage(expected)
const unsigned = unsignedSolWire(encode(message))
const wire = Uint8Array.from(atob(unsigned), (value) => value.charCodeAt(0))
wire.fill(7, 1, 65)
const signed = encode(wire)
const accept = async () => true

test('unsigned wire contains exactly one empty signature and the stored message', () => {
  const bytes = Uint8Array.from(atob(unsigned), (value) => value.charCodeAt(0))
  expect(bytes[0]).toBe(1)
  expect(bytes.slice(1, 65)).toEqual(new Uint8Array(64))
  expect(bytes.slice(65)).toEqual(message)
  expect(() => unsignedSolWire(encode(message) + '\n')).toThrow()
  expect(() => unsignedSolWire(encode(new Uint8Array(1168)))).toThrow()
})

test('verification supplies exact message and wallet to the signature verifier', async () => {
  const verified = await verifySignedSolTransfer(
    signed,
    expected,
    async (wallet, signature, bytes) => {
      expect(wallet).toBe(expected.walletAddress)
      expect(new Uint8Array(signature)).toEqual(new Uint8Array(64).fill(7))
      expect(new Uint8Array(bytes)).toEqual(message)
      return true
    },
  )
  expect(verified.signedBase64).toBe(signed)
  expect(verified.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
  await expect(verifySignedSolTransfer(signed, expected)).rejects.toThrow(
    'Invalid source wallet signature',
  )
  await expect(
    verifySignedSolTransfer(signed, expected, async () => false),
  ).rejects.toThrow()
})

test('changed intent, missing signature, trailing bytes, noncanonical base64 and size are refused', async () => {
  await expect(
    verifySignedSolTransfer(
      signed,
      { ...expected, amountLamports: '1' },
      accept,
    ),
  ).rejects.toThrow()
  const trailing = new Uint8Array(wire.length + 1)
  trailing.set(wire)
  for (const candidate of [
    unsigned,
    signed + '\n',
    signed.slice(0, -1),
    encode(trailing),
    encode(new Uint8Array(1233)),
    '!!!',
  ])
    await expect(
      verifySignedSolTransfer(candidate, expected, accept),
    ).rejects.toThrow()
  const extraSigner = new Uint8Array(wire.length + 64)
  extraSigner[0] = 2
  extraSigner.set(wire.slice(1, 65), 1)
  extraSigner.set(wire.slice(65), 129)
  await expect(
    verifySignedSolTransfer(encode(extraSigner), expected, accept),
  ).rejects.toThrow()
})

const RpcRequest = type({
  id: 'string | number',
  method: 'string',
  params: 'unknown[]',
})

test('production RPC verifies genesis and uses bounded confirmed submission and historical status reads', async () => {
  const verified = await verifySignedSolTransfer(signed, expected, accept)
  const methods: string[] = []
  let commitment = 'confirmed'
  let failed = false
  let pending = false
  let chainSigned = signed
  let chainSlot = 42
  let contradictory = false
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = RpcRequest.assert(await request.json())
      methods.push(body.method)
      let result: unknown
      switch (body.method) {
        case 'getGenesisHash':
          result = PAYMENT_NETWORKS.devnet.genesisHash
          break
        case 'getBlockHeight':
          expect(body.params).toEqual([{ commitment: 'confirmed' }])
          result = 101
          break
        case 'sendTransaction':
          expect(body.params).toEqual([
            signed,
            {
              encoding: 'base64',
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 0,
            },
          ])
          result = verified.signature
          break
        case 'getSignatureStatuses':
          expect(body.params).toEqual([
            [verified.signature],
            { searchTransactionHistory: true },
          ])
          result = {
            context: { slot: 42 },
            value: [
              pending
                ? null
                : {
                    slot: 42,
                    confirmations: 1,
                    err: failed
                      ? { InstructionError: [0, 'InvalidArgument'] }
                      : null,
                    confirmationStatus: commitment,
                  },
            ],
          }
          break
        case 'getTransaction':
          expect(body.params).toEqual([
            verified.signature,
            {
              encoding: 'base64',
              ...(commitment === 'finalized' ? {} : { commitment }),
              maxSupportedTransactionVersion: 0,
            },
          ])
          result = {
            slot: chainSlot,
            blockTime: null,
            version: 0,
            transaction: [chainSigned, 'base64'],
            meta: {
              err:
                failed !== contradictory
                  ? { InstructionError: [0, 'InvalidArgument'] }
                  : null,
              fee: 5000,
              preBalances: [],
              postBalances: [],
              innerInstructions: null,
              logMessages: null,
              preTokenBalances: [],
              postTokenBalances: [],
              rewards: [],
            },
          }
          break
        default:
          throw new Error('Unexpected RPC method')
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    },
  })
  try {
    const rpc = await createSolExecutionRpc({
      SOLANA_NETWORK: 'devnet',
      SOLANA_RPC_URL: server.url.toString(),
    })
    expect(methods).toEqual(['getGenesisHash'])
    expect(await rpc.blockHeight()).toBe(101n)
    expect(await rpc.send(signed)).toBe(verified.signature)
    expect(await rpc.status(verified.signature)).toEqual({
      signedBase64: signed,
      slot: '42',
      commitment: 'confirmed',
      failed: false,
    })
    commitment = 'finalized'
    failed = true
    expect(await rpc.status(verified.signature)).toEqual({
      signedBase64: signed,
      slot: '42',
      commitment: 'finalized',
      failed: true,
    })
    contradictory = true
    await expect(rpc.status(verified.signature)).rejects.toThrow(
      'Solana execution RPC request failed',
    )
    contradictory = false
    chainSlot = 43
    await expect(rpc.status(verified.signature)).rejects.toThrow(
      'Solana execution RPC request failed',
    )
    chainSlot = 42
    for (const bytes of [
      signed + '\n',
      encode(new Uint8Array([...wire, 0])),
      unsigned,
      '!!!',
    ]) {
      chainSigned = bytes
      await expect(rpc.status(verified.signature)).rejects.toThrow(
        'Solana execution RPC request failed',
      )
    }
    chainSigned = signed
    pending = true
    expect(await rpc.status(verified.signature)).toBeNull()
    expect(methods.at(-1)).toBe('getSignatureStatuses')
  } finally {
    await server.stop(true)
  }
})

test('non-devnet and wrong genesis expose no execution methods; provider errors are sanitized', async () => {
  let calls = 0
  let genesis = PAYMENT_NETWORKS.mainnet.genesisHash
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      calls++
      const body = RpcRequest.assert(await request.json())
      return Response.json(
        body.method === 'getGenesisHash'
          ? { jsonrpc: '2.0', id: body.id, result: genesis }
          : {
              jsonrpc: '2.0',
              id: body.id,
              error: { code: -32000, message: 'provider-secret-url' },
            },
      )
    },
  })
  const env = {
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: server.url.toString(),
  }
  try {
    await expect(
      createSolExecutionRpc({ ...env, SOLANA_NETWORK: 'mainnet' }),
    ).rejects.toThrow('requires devnet')
    expect(calls).toBe(0)
    await expect(createSolExecutionRpc(env)).rejects.toThrow('does not match')
    expect(calls).toBe(1)
    genesis = PAYMENT_NETWORKS.devnet.genesisHash
    const rpc = await createSolExecutionRpc(env)
    await expect(rpc.blockHeight()).rejects.toThrow(
      'Solana execution RPC request failed',
    )
    await expect(rpc.send(signed)).rejects.toThrow(
      'Solana execution RPC request failed',
    )
    await expect(rpc.status('bad')).rejects.toThrow(
      'Solana execution RPC request failed',
    )
  } finally {
    await server.stop(true)
  }
})
