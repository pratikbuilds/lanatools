import OAuthProvider, {
  OAuthError,
  getOAuthApi,
} from '@cloudflare/workers-oauth-provider'
import type { OAuthProviderOptions } from '@cloudflare/workers-oauth-provider'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import { MCP_SCOPES } from '@lanatools/contracts'
import { WorkerEntrypoint, env as bindings } from 'cloudflare:workers'
import type { McpTokenRevoker } from '../../api/src/mcp-service'
import { NO_LOGIN_TOOLS, createServer } from './server'
import type { ServerAccess } from './server'
import { Identity } from './identity'
import { ToolChoice, approveGrant, toolAccess } from './approve-grant'
import type { GrantEnv } from './approve-grant'
import { revokeClientTokens } from './revoke-tokens'
import { authorizeFirstParty } from './first-party-authorize'
import { json } from './json'

type McpEnv = Env &
  GrantEnv & {
    TYPESAFE_API_KEY?: string
  }

const OAuthContext = z.object({
  auth: z.object({ scope: z.array(z.string()) }),
})

/** The tool call parts of a JSON-RPC message; other fields are not read. */
const RpcMessage = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.object({ name: z.string().optional() }).optional(),
})

/** The JSON-RPC messages in an MCP POST, or none when it is not JSON. */
async function rpcMessages(request: Request) {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null)
  return (Array.isArray(body) ? body : [body]).flatMap((message) => {
    const parsed = RpcMessage.safeParse(message)
    return parsed.success ? [parsed.data] : []
  })
}

function serveMcp(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext,
  access: ServerAccess,
) {
  return createMcpHandler(
    () =>
      createServer(
        {
          api: env.API,
          typesafeApiKey: env.TYPESAFE_API_KEY,
          revokeClient: ({ userId, clientId, grantId }) => {
            ctx.waitUntil(
              revokeClientTokens(env.OAUTH_PROVIDER, userId, clientId, grantId),
            )
          },
        },
        access,
      ),
    { route: '/mcp' },
  )(request, env, ctx)
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
        const body = ToolChoice.extend({
          decision: z.enum(['approve', 'deny']),
        }).safeParse(await request.json().catch(() => null))
        if (!body.success) return json({ error: 'Invalid decision' }, 400)
        try {
          if (body.data.decision === 'deny') {
            const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle)
            await env.API.discardConsent(handle)
            return json({ redirectTo: denied.redirectTo }, 200, denied.headers)
          }
          const access = toolAccess(body.data)
          if ('error' in access) return json({ error: access.error }, 400)
          const token = /^Bearer (.+)$/.exec(
            request.headers.get('authorization') || '',
          )?.[1]
          if (!token) return json({ error: 'Sign in first' }, 401)
          const userId = await env.API.verifyPrivyToken(token)
          // The user's choice replaces the scopes the client asked for.
          const approved = await env.OAUTH_PROVIDER.approveConsent(
            request,
            handle,
            { scope: access.scopes },
          )
          const { redirectTo } = await approveGrant(
            env,
            approved.request,
            handle,
            userId,
            access,
          )
          return json({ redirectTo }, 200, approved.headers)
        } catch {
          return json({ error: 'Authorization failed. Please reconnect.' }, 400)
        }
      }
    }

    if (url.pathname === '/first-party/authorize' && request.method === 'POST')
      return authorizeFirstParty(request, env)

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
      return serveMcp(request, env, ctx, {
        props: ctx.props,
        scopes: auth.success ? auth.data.auth.scope : [],
      })
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

const oauthProvider = new OAuthProvider<McpEnv>(oauthOptions)

/**
 * One MCP URL for everyone. A request with a token goes through OAuthProvider
 * as before. Without one, the agent gets the no-login tools; calling any other
 * tool gets OAuthProvider's own 401, which makes the client ask the user to
 * log in.
 */
export default {
  async fetch(request: Request, env: McpEnv, ctx: ExecutionContext) {
    if (
      new URL(request.url).pathname !== '/mcp' ||
      request.headers.has('authorization')
    )
      return oauthProvider.fetch(request, env, ctx)
    const calls = (await rpcMessages(request)).filter(
      (message) => message.method === 'tools/call',
    )
    // The limit counts requests, so a batch of several calls needs login.
    if (
      calls.length > 1 ||
      calls.some((call) => !NO_LOGIN_TOOLS.has(call.params?.name ?? ''))
    )
      return oauthProvider.fetch(request, env, ctx)
    if (calls.length > 0) {
      const { success } = await env.NO_LOGIN_LIMITER.limit({
        key: request.headers.get('cf-connecting-ip') ?? 'unknown',
      })
      // A tool error the agent can read, rather than an HTTP error a client
      // may treat as the server being down.
      if (!success)
        return json({
          jsonrpc: '2.0',
          id: calls[0]?.id ?? null,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Too many calls without login. Wait a minute, or log in to LanaTools.',
              },
            ],
          },
        })
    }
    return serveMcp(request, env, ctx, null)
  },
} satisfies ExportedHandler<McpEnv>

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
