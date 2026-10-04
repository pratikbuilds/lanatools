import { expect, test } from 'bun:test'
import { createCursorCodec } from './cursor'

const url = 'https://devnet.helius-rpc.com/?api-key=SYNTHETIC_SECRET'
const input = { address: 'wallet', status: 'any', limit: 10 }

test('cursors survive new clients, preserve provider token, and hide URL/key', async () => {
  const cursor = await createCursorCodec(url).encode(
    'get_transaction_history',
    input,
    '450:12+opaque/界',
  )
  expect(
    await createCursorCodec(url).decode(
      'get_transaction_history',
      input,
      cursor,
    ),
  ).toBe('450:12+opaque/界')
  expect(cursor).not.toContain('SYNTHETIC_SECRET')
  expect(
    atob(cursor.split('.')[0]!.replaceAll('-', '+').replaceAll('_', '/')),
  ).not.toContain('SYNTHETIC_SECRET')
  expect(
    await createCursorCodec(url).decode(
      'get_transaction_history',
      { limit: 10, status: 'any', address: 'wallet' },
      cursor,
    ),
  ).toBe('450:12+opaque/界')
})
test('cursors reject tampering, forged input, wrong tool, RPC, credentials and query', async () => {
  const codec = createCursorCodec(url)
  const cursor = await codec.encode('get_transaction_history', input, '450:12')
  const [payload, signature] = cursor.split('.') as [string, string]
  const forgery =
    btoa(JSON.stringify({ v: 1, scope: 'made-up', token: '450:99' })).replace(
      /=+$/,
      '',
    ) +
    '.' +
    signature
  for (const invalid of [
    '',
    '450:12',
    'not-a-cursor',
    forgery,
    `${payload}A.${signature}`,
    `${payload}.${signature.slice(0, -2)}AA`,
    `${cursor}.extra`,
    `${payload}=.${signature}`,
  ])
    await expect(
      codec.decode('get_transaction_history', input, invalid),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(codec.decode('other', input, cursor)).rejects.toMatchObject({
    code: 'invalid_input',
  })
  for (const changed of [
    { ...input, address: 'other' },
    { ...input, limit: 11 },
    { ...input, status: 'failed' },
  ])
    await expect(
      codec.decode('get_transaction_history', changed, cursor),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  for (const changedUrl of [
    url.replace('devnet', 'mainnet'),
    url.replace('SYNTHETIC_SECRET', 'OTHER_SECRET'),
  ])
    await expect(
      createCursorCodec(changedUrl).decode(
        'get_transaction_history',
        input,
        cursor,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
})
