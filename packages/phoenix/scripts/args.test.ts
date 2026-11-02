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
      ['deposit', '0.01', '--asset', 'SOL'],
      { tool: 'phoenix_deposit', input: { amount: '0.01', asset: 'SOL' } },
    ],
    [
      ['withdraw', '0.01', '--asset', 'SOL'],
      { tool: 'phoenix_withdraw', input: { amount: '0.01', asset: 'SOL' } },
    ],
    [
      ['deposit', '5', '--asset', 'USDC'],
      { tool: 'phoenix_deposit', input: { amount: '5', asset: 'USDC' } },
    ],
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
      [
        'market',
        'SOL',
        'buy',
        '0.1',
        '--slippage-bps',
        '50',
        '--tp',
        '120',
        '--tp-worst',
        '119',
        '--sl',
        '110',
        '--sl-worst',
        '105',
      ],
      {
        tool: 'phoenix_market_order',
        input: {
          symbol: 'SOL',
          side: 'buy',
          size: '0.1',
          maxSlippageBps: 50,
          reduceOnly: false,
          takeProfit: { triggerPrice: '120', worstPrice: '119' },
          stopLoss: { triggerPrice: '110', worstPrice: '105' },
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
    [
      ['close', 'GOLD', '--subaccount', '3', '--limit-price', '3900'],
      {
        tool: 'phoenix_close_position',
        input: { symbol: 'GOLD', subaccount: 3, limitPrice: '3900' },
      },
    ],
    [
      ['close', 'SOL', '--subaccount', '0', '--slippage-bps', '100'],
      {
        tool: 'phoenix_close_position',
        input: { symbol: 'SOL', subaccount: 0, maxSlippageBps: 100 },
      },
    ],
    [
      ['cancel', 'GOLD', '--subaccount', '3', '--id', '7'],
      {
        tool: 'phoenix_cancel_orders',
        input: { symbol: 'GOLD', subaccount: 3, orderIds: ['7'] },
      },
    ],
    [
      ['add-margin', 'GOLD', '2.5'],
      {
        tool: 'phoenix_add_isolated_margin',
        input: { symbol: 'GOLD', amount: '2.5' },
      },
    ],
    [
      ['add-margin', 'GOLD', '2.5', '--subaccount', '3'],
      {
        tool: 'phoenix_add_isolated_margin',
        input: { symbol: 'GOLD', amount: '2.5', subaccount: 3 },
      },
    ],
    [
      [
        'set-tpsl',
        'SOL',
        '--tp',
        '120',
        '--tp-worst',
        '119',
        '--sl',
        '110',
        '--sl-worst',
        '105',
        '--percent',
        '50',
      ],
      {
        tool: 'phoenix_set_tpsl',
        input: {
          symbol: 'SOL',
          takeProfit: { triggerPrice: '120', worstPrice: '119' },
          stopLoss: { triggerPrice: '110', worstPrice: '105' },
          percent: 50,
        },
      },
    ],
    [
      [
        'set-tpsl',
        'GOLD',
        '--sl',
        '3700',
        '--sl-worst',
        '3600',
        '--size',
        '0.001',
        '--subaccount',
        '3',
      ],
      {
        tool: 'phoenix_set_tpsl',
        input: {
          symbol: 'GOLD',
          stopLoss: { triggerPrice: '3700', worstPrice: '3600' },
          size: '0.001',
          subaccount: 3,
        },
      },
    ],
    [
      ['cancel-tpsl', 'SOL', 'takeProfit'],
      {
        tool: 'phoenix_cancel_tpsl',
        input: { symbol: 'SOL', leg: 'takeProfit' },
      },
    ],
    [
      ['cancel-tpsl', 'SOL', 'both', '--slot', '2', '--subaccount', '3'],
      {
        tool: 'phoenix_cancel_tpsl',
        input: { symbol: 'SOL', leg: 'both', slot: 2, subaccount: 3 },
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

test('--isolated sets the margin mode and exact collateral on orders', () => {
  expect(
    parseCli([
      'market',
      'GOLD',
      'buy',
      '0.01',
      '--slippage-bps',
      '50',
      '--isolated',
      '--collateral-usdc',
      '2.50',
      '--collateral-sol',
      '0.05',
      ...RPC,
    ]),
  ).toMatchObject({
    tool: 'phoenix_market_order',
    input: {
      symbol: 'GOLD',
      maxSlippageBps: 50,
      marginMode: 'isolated',
      collateralUsdc: '2.50',
      collateralSol: '0.05',
    },
  })
  const limit = parseCli([
    'limit',
    'GOLD',
    'buy',
    '0.01',
    '3000',
    '--isolated',
    '--collateral-usdc',
    '2',
    ...RPC,
  ])
  expect(limit).toMatchObject({
    tool: 'phoenix_limit_order',
    input: { price: '3000', marginMode: 'isolated', collateralUsdc: '2' },
  })
  expect(limit).not.toHaveProperty('input.collateralSol')
  // Adding to an open position may move no collateral.
  expect(
    parseCli(['limit', 'GOLD', 'buy', '0.01', '3000', '--isolated', ...RPC]),
  ).toMatchObject({ input: { marginMode: 'isolated' } })
})

test('a cross order states no margin terms', () => {
  const cross = parseCli(['limit', 'SOL', 'buy', '0.1', '50', ...RPC])
  expect(cross).not.toHaveProperty('input.marginMode')
})

test('collateral needs --isolated and a plain decimal', () => {
  const order = ['market', 'GOLD', 'buy', '0.01', '--slippage-bps', '50']
  expect(() => parseCli([...order, '--collateral-usdc', '2', ...RPC])).toThrow(
    '--collateral-usdc and --collateral-sol need --isolated',
  )
  expect(() =>
    parseCli([...order, '--isolated', '--collateral-sol', 'lots', ...RPC]),
  ).toThrow('--collateral-sol must be a number such as 0.5')
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

test('set-tpsl needs a leg, both of its prices, and exactly one size', () => {
  const tp = ['--tp', '120', '--tp-worst', '119']
  for (const [argv, message] of [
    [['set-tpsl', 'SOL', '--percent', '50'], 'Give --tp, --sl or both'],
    [
      ['set-tpsl', 'SOL', '--tp', '120', '--percent', '50'],
      'Give both --tp and --tp-worst',
    ],
    [
      ['set-tpsl', 'SOL', '--sl-worst', '105', '--percent', '50'],
      'Give both --sl and --sl-worst',
    ],
    [['set-tpsl', 'SOL', ...tp], 'Give exactly one of --percent or --size'],
    [
      ['set-tpsl', 'SOL', ...tp, '--percent', '50', '--size', '1'],
      'Give exactly one of --percent or --size',
    ],
    [['set-tpsl', 'SOL', ...tp, '--percent', 'half'], 'whole number'],
    [['set-tpsl', ...tp, '--percent', '50'], 'Missing market symbol'],
  ] as const)
    expect(() => parseCli([...argv, ...RPC])).toThrow(message)
})

test('cancel-tpsl needs a market and a leg', () => {
  for (const [argv, message] of [
    [['cancel-tpsl'], 'Missing market symbol'],
    [['cancel-tpsl', 'SOL'], 'Missing leg'],
    [['cancel-tpsl', 'SOL', 'all'], 'Leg must be takeProfit, stopLoss or both'],
    [['cancel-tpsl', 'SOL', 'both', '--slot', 'x'], 'whole number'],
  ] as const)
    expect(() => parseCli([...argv, ...RPC])).toThrow(message)
})

test('missing or malformed arguments are usage errors', () => {
  for (const [argv, message] of [
    [[], 'Missing command'],
    [['buy'], 'Unknown command buy'],
    [['deposit'], 'Missing amount'],
    [['deposit', '1', '--asset', 'BTC'], '--asset must be USDC or SOL'],
    [['add-margin', 'GOLD'], 'Missing USDC amount'],
    [
      ['add-margin', 'GOLD', '1', '--subaccount', 'two'],
      '--subaccount must be a whole number',
    ],
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
