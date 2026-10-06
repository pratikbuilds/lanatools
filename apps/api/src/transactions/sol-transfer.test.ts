import { expect, test } from 'bun:test'
import {
  address,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit'
import {
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from '@solana-program/system'
import {
  buildSolTransferMessage,
  validateSolTransferMessage,
} from './sol-transfer'

const expected = {
  walletAddress: 'So11111111111111111111111111111111111111112',
  recipient: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amountLamports: '9007199254740993',
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 100n,
}

test('compiled transfer preserves exact amount, payer, signer and lifetime', () => {
  const bytes = buildSolTransferMessage(expected)
  const decoded = getCompiledTransactionMessageDecoder().decode(bytes)
  expect(decoded.version).toBe(0)
  if (decoded.version !== 0) throw new Error('Expected v0')
  expect(decoded.header).toEqual({
    numSignerAccounts: 1,
    numReadonlySignerAccounts: 0,
    numReadonlyNonSignerAccounts: 1,
  })
  expect(decoded.staticAccounts[0]).toBe(address(expected.walletAddress))
  expect(decoded.lifetimeToken).toBe(expected.blockhash)
  expect(decoded.instructions).toHaveLength(1)
  const instruction = decoded.instructions[0]
  if (!instruction?.data || !instruction.accountIndices)
    throw new Error('Missing transfer data')
  expect(decoded.staticAccounts[instruction.programAddressIndex]).toBe(
    SYSTEM_PROGRAM_ADDRESS,
  )
  expect(
    instruction.accountIndices.map((index) => decoded.staticAccounts[index]),
  ).toEqual([address(expected.walletAddress), address(expected.recipient)])
  expect(
    getTransferSolInstructionDataDecoder().decode(instruction.data).amount,
  ).toBe(9007199254740993n)
  expect(() => validateSolTransferMessage(bytes, expected)).not.toThrow()
})

test('changed source, destination, amount and blockhash are refused', () => {
  for (const mutation of [
    { walletAddress: expected.recipient, recipient: expected.walletAddress },
    { recipient: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
    { amountLamports: '9007199254740992' },
    { blockhash: expected.recipient },
  ])
    expect(() =>
      validateSolTransferMessage(
        buildSolTransferMessage({ ...expected, ...mutation }),
        expected,
      ),
    ).toThrow()
})

test('extra transfer, signer, instruction data and lookup shape are refused', () => {
  const decoded = getCompiledTransactionMessageDecoder().decode(
    buildSolTransferMessage(expected),
  )
  if (decoded.version !== 0) throw new Error('Expected v0')
  const instruction = decoded.instructions[0]
  if (!instruction?.data) throw new Error('Missing transfer')
  const mutations = [
    { ...decoded, instructions: [...decoded.instructions, instruction] },
    { ...decoded, header: { ...decoded.header, numSignerAccounts: 2 } },
    {
      ...decoded,
      staticAccounts: [
        ...decoded.staticAccounts,
        address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
      ],
    },
    {
      ...decoded,
      instructions: [{ ...instruction, data: new Uint8Array(12) }],
    },
  ]
  for (const message of mutations)
    expect(() =>
      validateSolTransferMessage(
        new Uint8Array(getCompiledTransactionMessageEncoder().encode(message)),
        expected,
      ),
    ).toThrow()
  const bytes = buildSolTransferMessage(expected)
  const withTrailing = new Uint8Array(bytes.length + 1)
  withTrailing.set(bytes)
  expect(() => validateSolTransferMessage(withTrailing, expected)).toThrow()
  const lookup = new Uint8Array(bytes)
  lookup[lookup.length - 1] = 1
  expect(() => validateSolTransferMessage(lookup, expected)).toThrow()
})

test('u64 endpoints stay exact and invalid amounts/source are refused', () => {
  for (const amountLamports of ['1', '18446744073709551615'])
    expect(() =>
      buildSolTransferMessage({ ...expected, amountLamports }),
    ).not.toThrow()
  for (const amountLamports of [
    '0',
    '-1',
    '1.2',
    '1e3',
    '01',
    '18446744073709551616',
  ])
    expect(() =>
      buildSolTransferMessage({ ...expected, amountLamports }),
    ).toThrow()
  expect(() =>
    buildSolTransferMessage({ ...expected, recipient: expected.walletAddress }),
  ).toThrow()
})
