import { expect, mock, test } from 'bun:test'
import { observeSubmission, transactionRpc } from './submission'
import type { TransactionRpc } from './submission'

const confirmed = {
  err: null,
  slot: 123n,
  confirmationStatus: 'confirmed',
} as const
const options = { attempts: 2, intervalMs: 0, lastValidBlockHeight: '500' }
function rpc(overrides: Partial<TransactionRpc> = {}): TransactionRpc {
  return {
    ...transactionRpc('https://unused.example'),
    status: async () => null,
    blockHeight: async () => 100n,
    ...overrides,
  }
}

test('a temporary status error does not end confirmation observation', async () => {
  const status = mock<TransactionRpc['status']>()
    .mockRejectedValueOnce(new Error('temporary outage'))
    .mockResolvedValue(confirmed)
  expect(
    await observeSubmission(rpc({ status }), 'signature', options),
  ).toMatchObject({ status: 'confirmed' })
  expect(status).toHaveBeenCalledTimes(2)
})

test('by default a send keeps watching a transaction that takes seconds to land', async () => {
  // Lands 20 polls in, about 15 seconds at the default interval.
  const status = mock<TransactionRpc['status']>().mockResolvedValue(null)
  for (let poll = 0; poll < 19; poll++) status.mockResolvedValueOnce(null)
  status.mockResolvedValueOnce(confirmed)
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((run: () => void) =>
    realSetTimeout(run, 0)) as typeof setTimeout
  try {
    expect(await observeSubmission(rpc({ status }), 'signature')).toMatchObject(
      { status: 'confirmed' },
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('only finalized expiry followed by an absent history status expires a signature', async () => {
  const calls: string[] = []
  const reader = rpc({
    status: async () => {
      calls.push('history')
      return null
    },
    blockHeight: async (commitment) => {
      calls.push(String(commitment))
      return 501n
    },
  })
  expect(await observeSubmission(reader, 'signature', options)).toEqual({
    status: 'expired',
    receipt: null,
  })
  expect(calls).toEqual(['history', 'history', 'finalized', 'history'])
})

test('expiry boundary, processed status, and unavailable evidence stay unknown', async () => {
  for (const reader of [
    rpc({ blockHeight: async () => 500n }),
    rpc({
      blockHeight: async () => {
        throw new Error('unavailable')
      },
    }),
    rpc({
      blockHeight: async () => 501n,
      status: async () => {
        throw new Error('unavailable')
      },
    }),
    rpc({
      blockHeight: async () => 501n,
      status: async () => ({ ...confirmed, confirmationStatus: 'processed' }),
    }),
  ]) {
    expect(await observeSubmission(reader, 'signature', options)).toEqual({
      status: 'unknown',
      receipt: null,
    })
  }
})

test.each([null, { InstructionError: [0, 'InvalidArgument'] }])(
  'a last-block transaction wins over expiry, error=%j',
  async (err) => {
    const status = mock<TransactionRpc['status']>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ ...confirmed, err })
    expect(
      await observeSubmission(
        rpc({ status, blockHeight: async () => 501n }),
        'signature',
        options,
      ),
    ).toMatchObject({ status: err === null ? 'confirmed' : 'failed' })
  },
)
