import { expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTransactionOperation, publicTransaction } from './transactions'

const review = {
  title: 'Test',
  description: 'Test',
  actionLabel: 'Sign',
  fields: [],
}
const prepared = {
  transaction: 'AQID',
  account: 'wallet',
  network: 'mainnet' as const,
  review,
  blockhash: 'blockhash',
  lastValidBlockHeight: '100',
}

test('operations validate stored execution metadata before returning a relay function', async () => {
  let builds = 0
  const calls: unknown[] = []
  const operation = defineTransactionOperation({
    arguments: z.strictObject({ amount: z.string().min(1) }),
    supportedNetworks: ['mainnet'],
    describe: () => review,
    async build(
      _args,
      _account,
      context: { requestId: string; network: 'mainnet' },
    ) {
      builds++
      return { ...prepared, execution: { requestId: context.requestId } }
    },
    submission: {
      schema: z.strictObject({ requestId: z.string().min(1) }),
      async send(wire, candidate, execution, context) {
        calls.push({ wire, candidate, execution, context })
        return 'signature'
      },
    },
  })
  const context = { requestId: 'private-order', network: 'mainnet' as const }
  await expect(
    operation.build({ amount: '1', wallet: 'unexpected' }, 'wallet', context),
  ).rejects.toThrow()
  expect(builds).toBe(0)
  const candidate = await operation.build({ amount: '1' }, 'wallet', context)
  expect(publicTransaction(candidate)).toEqual(prepared)
  expect(() =>
    operation.relay({ ...candidate, execution: { requestId: '' } }, context),
  ).toThrow()
  expect(calls).toHaveLength(0)
  const relay = operation.relay(candidate, context)
  expect(calls).toHaveLength(0)
  expect(await relay('signed-bytes')).toBe('signature')
  expect(calls).toEqual([
    {
      wire: 'signed-bytes',
      candidate: prepared,
      execution: { requestId: 'private-order' },
      context,
    },
  ])
  await expect(
    operation.build({ amount: '1' }, 'wallet', {
      requestId: '',
      network: 'mainnet',
    }),
  ).rejects.toThrow()
})

test('operations without provider metadata use an explicit relay and persist no execution field', async () => {
  const operation = defineTransactionOperation({
    arguments: z.strictObject({}),
    describe: () => review,
    async build(_args, _account, _context: { network: 'mainnet' }) {
      return prepared
    },
    submission: { schema: z.undefined(), send: async (wire) => wire },
  })
  const candidate = await operation.build({}, 'wallet', { network: 'mainnet' })
  expect(candidate).not.toHaveProperty('execution')
  expect(
    await operation.relay(candidate, { network: 'mainnet' })('signed'),
  ).toBe('signed')
  expect(() =>
    operation.relay(
      { ...candidate, execution: { surprise: true } },
      { network: 'mainnet' },
    ),
  ).toThrow()
})

test('operations follow the selected network and enforce provider support before building or sending', async () => {
  let builds = 0
  const definition = {
    arguments: z.strictObject({}),
    describe: () => review,
    async build(
      _args: unknown,
      _account: string,
      context: { network: 'devnet' | 'mainnet' },
    ) {
      builds++
      return { ...prepared, network: context.network }
    },
    submission: { schema: z.undefined(), send: async () => 'signature' },
  }
  const portable = defineTransactionOperation(definition)
  const devnet = { network: 'devnet' as const }
  const mainnet = { network: 'mainnet' as const }
  expect((await portable.build({}, 'wallet', devnet)).network).toBe('devnet')
  const candidate = await portable.build({}, 'wallet', mainnet)
  expect(candidate.network).toBe('mainnet')
  expect(() => portable.relay(candidate, devnet)).toThrow('network mismatch')
  const mainnetOnly = defineTransactionOperation({
    ...definition,
    supportedNetworks: ['mainnet'],
  })
  const previousBuilds = builds
  await expect(mainnetOnly.build({}, 'wallet', devnet)).rejects.toThrow(
    'configured network',
  )
  expect(() => mainnetOnly.relay(candidate, devnet)).toThrow(
    'configured network',
  )
  expect(builds).toBe(previousBuilds)
})
