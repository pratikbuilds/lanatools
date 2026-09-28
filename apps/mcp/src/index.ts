import OAuthProvider from '@cloudflare/workers-oauth-provider'
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server'
import { z } from 'zod'
import { env as bindings } from 'cloudflare:workers'
import type { McpAccessService } from '../../api/src/mcp-service'

type McpEnv = Env & {
  OAUTH_PROVIDER: OAuthHelpers
  API: Service<typeof McpAccessService>
}

const Identity = z.object({
  grantId: z.uuid(),
  userId: z.string().min(1),
  clientId: z.string().min(1),
})

function createServer(env: McpEnv) {
  const server = new McpServer({ name: 'LanaTools', version: '0.1.0' })
  server.registerTool(
    'whoami',
    {
      description:
        'Show which LanaTools account and client this connection uses',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (context) => {
      if (!context.http?.authInfo?.scopes.includes('account:read'))
        return {
          isError: true,
          content: [{ type: 'text', text: 'Missing account:read scope' }],
        }
      const identity = Identity.safeParse(getMcpAuthContext()?.props)
      if (!identity.success)
        return {
          isError: true,
          content: [{ type: 'text', text: 'Unauthorized' }],
        }
      const { grantId, userId, clientId } = identity.data
      const account = await env.API.whoami(grantId, userId, clientId)
      if (!account)
        return {
          isError: true,
          content: [{ type: 'text', text: 'Connection revoked' }],
        }
      return { content: [{ type: 'text', text: JSON.stringify(account) }] }
    },
  )
  return server
}

function cors(request: Request, env: McpEnv) {
  if (request.headers.get('origin') !== env.WEB_ORIGIN) return null
  return {
    'Access-Control-Allow-Origin': env.WEB_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  }
}

function json(
  request: Request,
  env: McpEnv,
  value: unknown,
  status = 200,
  extra?: Headers,
) {
  const headers = new Headers(extra)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'no-store')
  const allowed = cors(request, env)
  if (allowed)
    for (const [key, headerValue] of Object.entries(allowed))
      headers.set(key, headerValue)
  return new Response(JSON.stringify(value), { status, headers })
}

const defaultHandler = {
  async fetch(request: Request, env: McpEnv) {
    const url = new URL(request.url)
    if (url.pathname === '/authorize' && request.method === 'GET') {
      try {
        const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request)
        if (!auth.scope.includes('account:read'))
          return new Response('Missing account:read scope', { status: 400 })
        const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId)
        if (!client) return new Response('Unknown MCP client', { status: 400 })
        const consent = await env.OAUTH_PROVIDER.beginConsent(auth)
        await env.API.recordConsent({
          handle: consent.handle,
          clientId: auth.clientId,
          clientName: client.clientName || 'Unnamed MCP client',
          redirectUri: auth.redirectUri,
        })
        const destination = new URL('/connect', env.WEB_ORIGIN)
        destination.searchParams.set('handle', consent.handle)
        const headers = new Headers(consent.headers)
        headers.set('Location', destination.href)
        headers.set('Referrer-Policy', 'no-referrer')
        return new Response(null, { status: 302, headers })
      } catch {
        return new Response('Invalid authorization request', { status: 400 })
      }
    }

    if (url.pathname === '/consent' && request.method === 'OPTIONS') {
      const allowed = cors(request, env)
      return allowed
        ? new Response(null, { status: 204, headers: allowed })
        : new Response(null, { status: 403 })
    }

    if (url.pathname === '/consent') {
      if (!cors(request, env)) return new Response('Forbidden', { status: 403 })
      const handle = url.searchParams.get('handle')
      if (!handle)
        return json(request, env, { error: 'Missing consent handle' }, 400)
      if (request.method === 'GET') {
        const pending = await env.API.pendingConsent(handle)
        return pending
          ? json(request, env, pending)
          : json(request, env, { error: 'Authorization request expired' }, 404)
      }
      if (request.method === 'POST') {
        const body = z
          .object({ decision: z.enum(['approve', 'deny']) })
          .safeParse(await request.json().catch(() => null))
        if (!body.success)
          return json(request, env, { error: 'Invalid decision' }, 400)
        try {
          if (body.data.decision === 'deny') {
            const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle)
            await env.API.discardConsent(handle)
            return json(
              request,
              env,
              { redirectTo: denied.redirectTo },
              200,
              denied.headers,
            )
          }
          const token = /^Bearer (.+)$/.exec(
            request.headers.get('authorization') || '',
          )?.[1]
          if (!token) return json(request, env, { error: 'Sign in first' }, 401)
          const userId = await env.API.verifyPrivyToken(token)
          const approved = await env.OAUTH_PROVIDER.approveConsent(
            request,
            handle,
          )
          const { grantId } = await env.API.activateGrant(
            handle,
            approved.request.clientId,
            userId,
          )
          const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization(
            {
              request: approved.request,
              userId,
              scope: approved.request.scope,
              props: { grantId, userId, clientId: approved.request.clientId },
              metadata: { label: 'LanaTools connection' },
            },
          )
          return json(request, env, { redirectTo }, 200, approved.headers)
        } catch {
          return json(
            request,
            env,
            { error: 'Authorization failed. Please reconnect.' },
            400,
          )
        }
      }
    }

    return new Response('Not found', { status: 404 })
  },
}

export default new OAuthProvider<McpEnv>({
  resourceMetadata: {
    resource: new URL('/mcp', bindings.MCP_ORIGIN).href,
    authorization_servers: [bindings.MCP_ORIGIN],
    scopes_supported: ['account:read'],
    resource_name: 'LanaTools MCP',
  },
  apiRoute: '/mcp',
  apiHandler: {
    fetch(request, env, ctx) {
      return createMcpHandler(() => createServer(env), { route: '/mcp' })(
        request,
        env,
        ctx,
      )
    },
  },
  defaultHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  allowPlainPKCE: false,
  scopesSupported: ['account:read'],
})
