import { homedir } from 'node:os'
import { expect, test } from 'bun:test'
import { parseCli } from './args'

const RPC = ['--rpc', 'https://rpc.example']
const WALLET = 'DuyJffWSmNtaauW2UDiULLUeT1J57UQWphUoZCwvvDdm'

test('each command maps to its trade tool and input', () => {
  const cases: Array<[string[], unknown]> = [
    [['activate'], { tool: 'phoenix_activate_account', input: {} }],
    [
      ['activate', '--code', 'ABC123'],
      { tool: 'phoenix_activate_account', input: { referralCode: 'ABC123' } },
    ],
    [['deposit', '25'], { tool: 'phoenix_deposit', input: { amount: '25' } }],
    [['withdraw', '5'], { tool: 'phoenix_withdraw', input: { amount: '5' } }],
    [
      ['market', 'SOL', 'buy', '0.1', '--slippage-bps', '50'],
      {
        tool: 'phoenix_market_order',
        input: {
          symbol: 'SOL',
          side: 'buy',
          size: '0.1',
          maxSlippageBps: 50,
          reduceOnly: false,
        },
      },
    ],
    [
      ['market', 'SOL', 'sell', '0.1', '--limit-price', '110', '--reduce-only'],
      {
        tool: 'phoenix_market_order',
        input: {
          symbol: 'SOL',
          side: 'sell',
          size: '0.1',
          limitPrice: '110',
          reduceOnly: true,
        },
      },
    ],
    [
      ['limit', 'SOL', 'buy', '0.1', '50', '--post-only'],
      {
        tool: 'phoenix_limit_order',
        input: {
          symbol: 'SOL',
          side: 'buy',
          size: '0.1',
          price: '50',
          postOnly: true,
          reduceOnly: false,
        },
      },
    ],
    [
      ['cancel', 'SOL'],
      { tool: 'phoenix_cancel_orders', input: { symbol: 'SOL' } },
    ],
    [
      ['cancel', 'SOL', '--id', '7', '--id', '9'],
      {
        tool: 'phoenix_cancel_orders',
        input: { symbol: 'SOL', orderIds: ['7', '9'] },
      },
    ],
    [
      ['close', 'SOL', '--fraction', '0.5', '--slippage-bps', '100'],
      {
        tool: 'phoenix_close_position',
        input: { symbol: 'SOL', fraction: 0.5, maxSlippageBps: 100 },
      },
    ],
  ]
  for (const [argv, expected] of cases)
    expect(parseCli([...argv, ...RPC])).toMatchObject({
      command: 'tool',
      ...(expected as object),
    })
  expect(parseCli(['state', ...RPC])).toMatchObject({ command: 'state' })
})

test('options default to the CLI wallet and real sends', () => {
  expect(parseCli(['state', ...RPC])).toMatchObject({
    rpc: 'https://rpc.example',
    keypair: `${homedir()}/.config/solana/id.json`,
    dryRun: false,
    as: null,
  })
})

test('an RPC is required; there is no default network', () => {
  expect(() => parseCli(['state'])).toThrow('Missing --rpc')
})

test('--as only simulates, and only for a real address', () => {
  expect(
    parseCli(['deposit', '1', '--dry-run', '--as', WALLET, ...RPC]),
  ).toMatchObject({ dryRun: true, as: WALLET })
  expect(() => parseCli(['deposit', '1', '--as', WALLET, ...RPC])).toThrow(
    '--as only simulates; it needs --dry-run',
  )
  expect(() =>
    parseCli(['deposit', '1', '--dry-run', '--as', 'nope', ...RPC]),
  ).toThrow('--as must be a Solana address')
})

test('market and close orders need exactly one worst price', () => {
  for (const argv of [
    ['market', 'SOL', 'buy', '0.1'],
    [
      'market',
      'SOL',
      'buy',
      '0.1',
      '--slippage-bps',
      '5',
      '--limit-price',
      '1',
    ],
    ['close', 'SOL'],
  ])
    expect(() => parseCli([...argv, ...RPC])).toThrow(
      'Give exactly one of --slippage-bps or --limit-price',
    )
})

test('missing or malformed arguments are usage errors', () => {
  for (const [argv, message] of [
    [[], 'Missing command'],
    [['buy'], 'Unknown command buy'],
    [['deposit'], 'Missing USDC amount'],
    [
      ['market', 'SOL', 'long', '1', '--slippage-bps', '5'],
      'Side must be buy or sell',
    ],
    [['market', 'SOL', 'buy', '1', '--slippage-bps', '0.5'], 'whole number'],
    [
      ['close', 'SOL', '--fraction', 'half', '--slippage-bps', '5'],
      'a number such as 0.5',
    ],
    [['state', '--bogus'], "Unknown option '--bogus'"],
  ] as const)
    expect(() => parseCli([...argv, ...RPC])).toThrow(message)
})
