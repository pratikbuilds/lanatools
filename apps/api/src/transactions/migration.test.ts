import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdir } from 'node:fs/promises'

test('transaction permission migration preserves existing grants and links while starting permission off', async () => {
  const db = new Database(':memory:')
  const dir = new URL('../../drizzle/', import.meta.url)
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort()
  async function apply(file: string) {
    for (const statement of (await Bun.file(new URL(file, dir)).text()).split(
      '--> statement-breakpoint',
    ))
      db.exec(statement)
  }
  try {
    for (const file of files) {
      if (file.startsWith('0013')) break
      await apply(file)
    }
    db.run(
      'insert into mcp_grant (id,privy_user_id,client_id,status,scope,limit_micro_usd,created_at) values (?,?,?,?,?,?,?)',
      [
        'existing-grant',
        'existing-owner',
        'existing-client',
        'active',
        'account:read payments:pay',
        123456,
        123,
      ],
    )
    db.run(
      'insert into transaction_request (id,privy_user_id,client_id,originating_grant_id,idempotency_key,canonical_input,input_hash,execution,network,created_at) values (?,?,?,?,?,?,?,?,?,?)',
      [
        'existing-request',
        'existing-owner',
        'existing-client',
        'existing-grant',
        'send',
        '{}',
        'preexisting',
        'external',
        'devnet',
        123,
      ],
    )
    db.run(
      'insert into transaction_link (token_hash,request_id,grant_id,expires_at,created_at) values (?,?,?,?,?)',
      ['old-link-hash', 'existing-request', 'existing-grant', 456, 123],
    )
    await apply('0013_third_albert_cleary.sql')
    expect(
      db
        .query(
          'select id,scope,limit_micro_usd,created_at,outgoing_allowed from mcp_grant',
        )
        .get(),
    ).toEqual({
      id: 'existing-grant',
      scope: 'account:read payments:pay',
      limit_micro_usd: 123456,
      created_at: 123,
      outgoing_allowed: 0,
    })
    expect(
      db
        .query(
          'select l.token_hash from transaction_link l join mcp_grant g on g.id=l.grant_id join transaction_request r on r.id=l.request_id',
        )
        .get(),
    ).toEqual({ token_hash: 'old-link-hash' })
    expect(db.query('pragma foreign_key_check').all()).toEqual([])
    expect(() => db.run('update mcp_grant set outgoing_allowed=2')).toThrow()
    expect(db.query('select * from transaction_signer').all()).toEqual([])
  } finally {
    db.close()
  }
})
