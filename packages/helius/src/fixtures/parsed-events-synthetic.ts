/**
 * Synthetic offline fixtures, NOT recorded production responses.
 * Fields follow official Helius Parsed Events docs reviewed 2026-10-03:
 * https://www.helius.dev/docs/parsed-events/parsed-response
 * https://www.helius.dev/docs/parsed-events/quickstart
 * Values deliberately exercise fees, rent and unsafe-number token amounts.
 */
export const owner = '11111111111111111111111111111111'
export const recipient = 'So11111111111111111111111111111111111111112'
export const program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function testSignature(index = 0) {
  return '1'.repeat(63) + alphabet[index % alphabet.length]!
}
export function rawTransaction(index = 0, failed = false) {
  return {
    slot: 50 - index,
    blockTime: 1700000100 - index,
    transaction: {
      signatures: [testSignature(index)],
      message: { accountKeys: [owner, recipient], instructions: [] },
    },
    meta: {
      err: failed ? { InstructionError: [0, 'InvalidArgument'] } : null,
      fee: 5000,
      loadedAddresses: { writable: [program], readonly: [] },
      preBalances: [5_000_000_000, 0, 0],
      postBalances: [3_997_955_720, 1_000_000_000, 2_039_280],
      preTokenBalances: [
        {
          accountIndex: 1,
          owner,
          mint: recipient,
          uiTokenAmount: { amount: '18446744073709551615', decimals: 6 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          owner,
          mint: recipient,
          uiTokenAmount: { amount: '18446744073708551615', decimals: 6 },
        },
      ],
    },
  }
}
export function parsedEvent(index = 0, failed = false) {
  return {
    signature: testSignature(index),
    parserStatus: 'OK',
    parsed: {
      slot: 50 - index,
      blockTime: 1700000100 - index,
      fee: 5000,
      feePayer: owner,
      transactionStatus: failed ? 'ERROR' : 'OK',
      error: failed ? { InstructionError: [0, 'InvalidArgument'] } : null,
      nativeTransfers: [
        {
          fromUserAccount: owner,
          toUserAccount: recipient,
          amount: 1_000_000_000,
        },
      ],
      tokenTransfers: [
        {
          fromUserAccount: owner,
          toUserAccount: recipient,
          fromTokenAccount: owner,
          toTokenAccount: recipient,
          mint: recipient,
          rawTokenAmount: '18446744073709551615',
          decimals: 6,
        },
      ],
      summary: {
        type: 'swap',
        description: 'Synthetic swap for offline coverage',
      },
      instructions: [
        {
          programId: program,
          instructionName: 'transfer_checked',
          decoded: { args: { amount: '1000000', decimals: 6 } },
        },
      ],
    },
    rawTransaction: rawTransaction(index, failed),
  }
}
