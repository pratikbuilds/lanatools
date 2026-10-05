import OAuthProvider, {
  OAuthError,
  getOAuthApi,
} from '@cloudflare/workers-oauth-provider'
import type {
  OAuthHelpers,
  OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import {
  MCP_SCOPES,
  TOOL_SCOPES,
  grantScopes,
  parseClientLimit,
} from '@lanatools/contracts'
import { WorkerEntrypoint, env as bindings } from 'cloudflare:workers'
import type {
  McpAccessService,
  McpTokenRevoker,
} from '../../api/src/mcp-service'
import { createServer } from './server'
import { Identity } from './identity'
import { completeApproval } from './complete-approval'
import { revokeClientTokens } from './revoke-tokens'

type McpEnv = Env & {
  OAUTH_PROVIDER: OAuthHelpers
  API: Service<typeof McpAccessService>
  TYPESAFE_API_KEY?: string
}

const OAuthContext = z.object({
  auth: z.object({ scope: z.array(z.string()) }),
})

function json(value: unknown, status = 200, extra?: Headers) {
  const headers = new Headers(extra)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(value), { status, headers })
}

const defaultHandler = {
  async fetch(request: Request, env: McpEnv) {
    const url = new URL(request.url)
    if (url.pathname === '/authorize' && request.method === 'GET') {
      try {
        // The user chooses the tool families on the consent screen, so the
        // scopes a client asks for, if any, are not checked here.
        const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request)
        const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId)
        if (!client) return new Response('Unknown MCP client', { status: 400 })
        const consent = await env.OAUTH_PROVIDER.beginConsent(auth)
        await env.API.recordConsent({
          handle: consent.handle,
          clientId: auth.clientId,
          clientName: client.clientName || 'Unnamed MCP client',
          redirectUri: auth.redirectUri,
        })
        const destination = new URL('/connect', env.MCP_ORIGIN)
        destination.searchParams.set('handle', consent.handle)
        const headers = new Headers(consent.headers)
        headers.set('Location', destination.href)
        headers.set('Referrer-Policy', 'no-referrer')
        return new Response(null, { status: 302, headers })
      } catch {
        return new Response('Invalid authorization request', { status: 400 })
      }
    }

    if (url.pathname === '/connect' && request.method === 'GET') {
      const asset = await env.ASSETS.fetch(
        new Request(new URL('/', url), request),
      )
      const headers = new Headers(asset.headers)
      headers.set('Cache-Control', 'no-store')
      headers.set('Referrer-Policy', 'no-referrer')
      headers.set(
        'Content-Security-Policy',
        "script-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      )
      headers.set('X-Frame-Options', 'DENY')
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(asset.body, { status: asset.status, headers })
    }

    if (url.pathname.startsWith('/assets/') && request.method === 'GET')
      return env.ASSETS.fetch(request)

    if (url.pathname === '/consent') {
      const handle = url.searchParams.get('handle')
      if (!handle) return json({ error: 'Missing consent handle' }, 400)
      if (request.method === 'GET') {
        const pending = await env.API.pendingConsent(handle)
        return pending
          ? json(pending)
          : json({ error: 'Authorization request expired' }, 404)
      }
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== env.MCP_ORIGIN)
          return new Response('Forbidden', { status: 403 })
        const body = z
          .object({
            decision: z.enum(['approve', 'deny']),
            // The tool families the user chose; none leaves the catalog only.
            scopes: z.array(z.enum(TOOL_SCOPES)).default([]),
            // Required when the user allows payments.
            limitUsd: z.string().optional(),
          })
          .safeParse(await request.json().catch(() => null))
        if (!body.success) return json({ error: 'Invalid decision' }, 400)
        const scopes = grantScopes(body.data.scopes)
        if (!scopes) return json({ error: 'Invalid tool access' }, 400)
        const limitMicroUsd =
          body.data.limitUsd === undefined
            ? null
            : parseClientLimit(body.data.limitUsd)
        if (body.data.limitUsd !== undefined && limitMicroUsd === null)
          return json({ error: 'Invalid spending limit' }, 400)
        try {
          if (body.data.decision === 'deny') {
            const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle)
            await env.API.discardConsent(handle)
            return json({ redirectTo: denied.redirectTo }, 200, denied.headers)
          }
          if (scopes.includes('payments:pay') && limitMicroUsd === null)
            return json({ error: 'Set a spending limit' }, 400)
          const token = /^Bearer (.+)$/.exec(
            request.headers.get('authorization') || '',
          )?.[1]
          if (!token) return json({ error: 'Sign in first' }, 401)
          const userId = await env.API.verifyPrivyToken(token)
          // The user's choice replaces the scopes the client asked for.
          const approved = await env.OAUTH_PROVIDER.approveConsent(
            request,
            handle,
            { scope: scopes },
          )
          const { grantId } = await env.API.prepareGrant(
            handle,
            approved.request.clientId,
            userId,
          )
          const { redirectTo } = await completeApproval(
            () =>
              env.OAUTH_PROVIDER.completeAuthorization({
                request: approved.request,
                // OAuthProvider separates the subject from its code with colons.
                userId: encodeURIComponent(userId),
                scope: approved.request.scope,
                props: { grantId, userId, clientId: approved.request.clientId },
                // Lets a dashboard revocation find this OAuth grant in KV.
                metadata: { label: 'LanaTools connection', grantId },
              }),
            () =>
              env.API.activateGrant(
                handle,
                { grantId, userId, clientId: approved.request.clientId },
                body.data.scopes,
                limitMicroUsd,
              ),
          )
          return json({ redirectTo }, 200, approved.headers)
        } catch {
          return json({ error: 'Authorization failed. Please reconnect.' }, 400)
        }
      }
    }

    return new Response('Not found', { status: 404 })
  },
}

const oauthOptions: OAuthProviderOptions<McpEnv> = {
  resourceMetadata: {
    resource: new URL('/mcp', bindings.MCP_ORIGIN).href,
    authorization_servers: [bindings.MCP_ORIGIN],
    scopes_supported: [...MCP_SCOPES],
    resource_name: 'LanaTools MCP',
  },
  apiRoute: '/mcp',
  apiHandler: {
    fetch(request, env, ctx) {
      const auth = OAuthContext.safeParse(ctx)
      return createMcpHandler(
        () =>
          createServer(
            {
              api: env.API,
              typesafeApiKey: env.TYPESAFE_API_KEY,
              revokeClient: ({ userId, clientId, grantId }) => {
                ctx.waitUntil(
                  revokeClientTokens(
                    env.OAUTH_PROVIDER,
                    userId,
                    clientId,
                    grantId,
                  ),
                )
              },
            },
            ctx.props,
            auth.success ? auth.data.auth.scope : [],
          ),
        { route: '/mcp' },
      )(request, env, ctx)
    },
  },
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  allowPlainPKCE: false,
  scopesSupported: [...MCP_SCOPES],
  // A revoked client cannot mint new tokens. invalid_grant also makes the
  // provider delete this OAuth grant and its tokens.
  async tokenExchangeCallback({ props }) {
    const identity = Identity.safeParse(props)
    if (!identity.success)
      throw new OAuthError('invalid_grant', { description: 'Unknown grant' })
    let active: unknown
    try {
      active = await (bindings as McpEnv).API.whoami(identity.data)
    } catch {
      throw new OAuthError('temporarily_unavailable', {
        description: 'Try again shortly',
        statusCode: 503,
      })
    }
    if (!active)
      throw new OAuthError('invalid_grant', {
        description: 'Connection revoked',
      })
  },
}

export default new OAuthProvider<McpEnv>(oauthOptions)

/** Called by the API Worker when a user revokes a client from the dashboard. */
export class McpTokenService
  extends WorkerEntrypoint<McpEnv>
  implements McpTokenRevoker
{
  async revokeClient(userId: string, clientId: string, grantId: string) {
    await revokeClientTokens(
      getOAuthApi(oauthOptions, this.env),
      userId,
      clientId,
      grantId,
    )
  }
}
