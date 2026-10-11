import { AuthorizationError } from '@cloudflare/workers-oauth-provider'
import type { AuthRequest } from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'
import { ToolChoice, approveGrant, toolAccess } from './approve-grant'
import type { GrantEnv } from './approve-grant'
import { json } from './json'

export type FirstPartyEnv = GrantEnv & {
  MCP_ORIGIN: string
  /** Comma-separated client IDs that may skip the web consent page. */
  FIRST_PARTY_CLIENT_IDS: string
}

const FirstPartyRequest = ToolChoice.extend({
  client_id: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_challenge: z.string().min(1),
  code_challenge_method: z.literal('S256'),
  state: z.string(),
  resource: z.string().min(1),
  decision: z.enum(['approve', 'deny']),
})

/**
 * Approves a grant for LanaTools' own apps, which hold a Privy session but
 * cannot run the browser-bound web consent. The code comes back in the body,
 * so no other app can intercept it on the way to a custom-scheme redirect.
 */
export async function authorizeFirstParty(
  request: Request,
  env: FirstPartyEnv,
) {
  const body = FirstPartyRequest.safeParse(
    await request.json().catch(() => null),
  )
  if (!body.success)
    return json({ error: 'Invalid authorization request' }, 400)
  const firstParty = new Set(
    env.FIRST_PARTY_CLIENT_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )
  if (!firstParty.has(body.data.client_id))
    return json({ error: 'Client must use the consent page' }, 403)

  let auth: AuthRequest
  try {
    // The same checks as /authorize: a registered client, its exact redirect
    // URI, S256 PKCE and a known resource.
    const authorize = new URL('/authorize', env.MCP_ORIGIN)
    authorize.search = new URLSearchParams({
      response_type: 'code',
      client_id: body.data.client_id,
      redirect_uri: body.data.redirect_uri,
      state: body.data.state,
      code_challenge: body.data.code_challenge,
      code_challenge_method: body.data.code_challenge_method,
      resource: body.data.resource,
    }).toString()
    auth = await env.OAUTH_PROVIDER.parseAuthRequest(new Request(authorize))
  } catch (error) {
    if (error instanceof AuthorizationError)
      return json({ error: 'Invalid authorization request' }, 400)
    return failed(body.data.client_id, error)
  }
  if (body.data.decision === 'deny')
    return json({ error: 'access_denied' }, 403)

  const access = toolAccess(body.data)
  if ('error' in access) return json({ error: access.error }, 400)
  const token = /^Bearer (.+)$/.exec(
    request.headers.get('authorization') || '',
  )?.[1]
  if (!token) return json({ error: 'Sign in first' }, 401)
  let userId: string
  try {
    userId = await env.API.verifyPrivyToken(token)
  } catch {
    return json({ error: 'Sign in again' }, 401)
  }

  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId)
    if (!client) throw new Error('MCP client disappeared during authorization')
    // There is no browser consent here; this row only carries the client's
    // details to the grant, and activation deletes it.
    const handle = crypto.randomUUID()
    await env.API.recordConsent({
      handle,
      clientId: auth.clientId,
      clientName: client.clientName || 'Unnamed MCP client',
      redirectUri: auth.redirectUri,
    })
    const { redirectTo } = await approveGrant(env, auth, handle, userId, access)
    const code = new URL(redirectTo).searchParams.get('code')
    if (!code) throw new Error('Authorization returned no code')
    return json({ code, state: body.data.state })
  } catch (error) {
    return failed(auth.clientId, error)
  }
}

function failed(clientId: string, error: unknown) {
  console.error(
    JSON.stringify({
      message: 'First-party authorization failed',
      clientId,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
  return json({ error: 'Authorization failed. Please try again.' }, 500)
}
