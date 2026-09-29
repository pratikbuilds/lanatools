import { expect, test } from 'bun:test'
import type { GrantSummary } from '@cloudflare/workers-oauth-provider'
import { revokeClientTokens } from './revoke-tokens'

function grant(id: string, clientId: string, grantId?: string): GrantSummary {
  return {
    id,
    clientId,
    userId: 'did%3Aprivy%3Auser',
    scope: ['account:read'],
    metadata: grantId ? { label: 'LanaTools connection', grantId } : {},
    createdAt: 0,
  }
}

test('revokes only the OAuth grants issued for that LanaTools grant', async () => {
  const pages = [
    {
      items: [
        grant('oauth-a', 'client', 'old'),
        grant('oauth-b', 'client', 'new'),
      ],
      cursor: 'next',
    },
    {
      items: [
        grant('oauth-legacy', 'client'),
        grant('oauth-other', 'other', 'old'),
      ],
    },
  ]
  const listed: (string | undefined)[] = []
  const revoked: [string, string][] = []
  await revokeClientTokens(
    {
      listUserGrants: (userId, options) => {
        expect(userId).toBe('did%3Aprivy%3Auser')
        listed.push(options?.cursor)
        return Promise.resolve(pages[listed.length - 1] ?? { items: [] })
      },
      revokeGrant: (id, userId) => {
        revoked.push([id, userId])
        return Promise.resolve()
      },
    },
    'did:privy:user',
    'client',
    'old',
  )
  expect(listed).toEqual([undefined, 'next'])
  expect(revoked.map(([id]) => id).sort()).toEqual(['oauth-a', 'oauth-legacy'])
  expect(revoked.every(([, user]) => user === 'did%3Aprivy%3Auser')).toBe(true)
})
