import { expect, mock, test } from 'bun:test'
import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import { approveGrant, toolAccess } from './approve-grant'
import type { GrantEnv } from './approve-grant'

test('a valid choice grants account:read, the chosen families and the limit', () => {
  expect(
    toolAccess({ scopes: ['payments:pay', 'helius:read'], limitUsd: '2.50' }),
  ).toEqual({
    toolScopes: ['payments:pay', 'helius:read'],
    scopes: ['account:read', 'helius:read', 'payments:pay'],
    limitMicroUsd: 2_500_000,
  })
  expect(toolAccess({ scopes: [] })).toEqual({
    toolScopes: [],
    scopes: ['account:read'],
    limitMicroUsd: null,
  })
})

test('a choice that cannot be granted says why', () => {
  expect(toolAccess({ scopes: ['helius:read', 'helius:read'] })).toEqual({
    error: 'Invalid tool access',
  })
  expect(toolAccess({ scopes: ['helius:read'], limitUsd: 'abc' })).toEqual({
    error: 'Invalid spending limit',
  })
  expect(toolAccess({ scopes: ['payments:pay'] })).toEqual({
    error: 'Set a spending limit',
  })
  expect(toolAccess({ scopes: ['helius:read'], limitUsd: '5' })).toEqual({
    error: 'A spending limit needs payments',
  })
})

test('approving issues a code for the chosen scopes, then activates the grant', async () => {
  const calls: unknown[][] = []
  const env = {
    OAUTH_PROVIDER: {
      completeAuthorization: mock(async (options: unknown) => {
        calls.push(['completeAuthorization', options])
        return { redirectTo: 'lanatools://oauth/callback?code=code-1' }
      }),
    },
    API: {
      prepareGrant: mock(async (...args: unknown[]) => {
        calls.push(['prepareGrant', ...args])
        return { grantId: 'grant-1' }
      }),
      activateGrant: mock(async (...args: unknown[]) => {
        calls.push(['activateGrant', ...args])
      }),
    },
  } as unknown as GrantEnv
  // The client asked for fewer scopes than the user chose.
  const request = {
    responseType: 'code',
    clientId: 'client-1',
    redirectUri: 'lanatools://oauth/callback',
    scope: ['account:read'],
    state: 'state-1',
  } as AuthRequest
  const access = {
    toolScopes: ['payments:pay' as const],
    scopes: ['account:read' as const, 'payments:pay' as const],
    limitMicroUsd: 2_500_000,
  }
  const identity = {
    grantId: 'grant-1',
    userId: 'did:privy:user-1',
    clientId: 'client-1',
  }

  expect(
    await approveGrant(env, request, 'handle-1', 'did:privy:user-1', access),
  ).toEqual({ redirectTo: 'lanatools://oauth/callback?code=code-1' })
  expect(calls).toEqual([
    ['prepareGrant', 'handle-1', 'client-1', 'did:privy:user-1'],
    [
      'completeAuthorization',
      {
        request: { ...request, scope: access.scopes },
        userId: 'did%3Aprivy%3Auser-1',
        scope: access.scopes,
        props: identity,
        metadata: { label: 'LanaTools connection', grantId: 'grant-1' },
      },
    ],
    ['activateGrant', 'handle-1', identity, ['payments:pay'], 2_500_000],
  ])
})
