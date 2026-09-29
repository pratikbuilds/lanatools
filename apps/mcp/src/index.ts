import OAuthProvider, {
  OAuthError,
  getOAuthApi,
} from '@cloudflare/workers-oauth-provider'
import type {
  OAuthHelpers,
  OAuthProviderOptions,
} from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import { MCP_SCOPES, isMcpScope, parseUsd } from '@lanatools/contracts'
import { WorkerEntrypoint, env as bindings } from 'cloudflare:workers'
import type {
  McpAccessService,
  McpTokenRevoker,
} from '../../api/src/mcp-service'
import { completeApproval } from './complete-approval'
import { revokeClientTokens } from './revoke-tokens'

type McpEnv = Env & {
  OAUTH_PROVIDER: OAuthHelpers
  API: Service<typeof McpAccessService>
}

const Identity = z.object({
  grantId: z.uuid(),
  userId: z.string().min(1),
  clientId: z.string().min(1),
})
const OAuthContext = z.object({
  auth: z.object({ scope: z.array(z.string()) }),
})

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

function createServer(
  env: McpEnv,
  ctx: ExecutionContext,
  props: unknown,
  scopes: string[],
) {
  // Every tool runs through this check, so a revoked grant cannot reach one
  // even while its access token has not expired yet.
  async function withGrant(
    scope: string,
    run: (
      identity: z.infer<typeof Identity>,
    ) => CallToolResult | Promise<CallToolResult>,
  ) {
    if (!scopes.includes(scope)) return toolError(`Missing ${scope} scope`)
    const identity = Identity.safeParse(props)
    if (!identity.success) return toolError('Unauthorized')
    const { grantId, userId, clientId } = identity.data
    if (!(await env.API.whoami(grantId, userId, clientId))) {
      ctx.waitUntil(
        revokeClientTokens(env.OAUTH_PROVIDER, userId, clientId, grantId),
      )
      return toolError('Connection revoked')
    }
    return run(identity.data)
  }

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
    () =>
      withGrant('account:read', ({ userId, clientId }) => ({
        content: [{ type: 'text', text: JSON.stringify({ userId, clientId }) }],
      })),
  )
  server.registerTool(
    'pay_http',
    {
      title: 'Pay for an HTTP request',
      description: [
        "Calls an https endpoint the user gave you. If it answers HTTP 402 with a fixed MPP or x402 charge, pays it in USDC from the user's LanaTools wallet and returns the endpoint's response.",
        "The charge must not exceed max_usd or this client's remaining spending limit.",
        'Never repeat a call whose payment is reported as uncertain: it may already have been paid.',
      ].join(' '),
      inputSchema: z.object({
        url: z.url().describe('The https endpoint to call'),
        method: z.enum(['GET', 'POST']).default('GET'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'Optional request headers: accept, accept-language, content-type, user-agent',
          ),
        body: z
          .union([
            z.string(),
            z.record(z.string(), z.unknown()),
            z.array(z.unknown()),
          ])
          .optional()
          .describe('POST body: text, or JSON sent as application/json'),
        protocol: z
          .enum(['auto', 'mpp', 'x402'])
          .default('auto')
          .describe('Payment protocol; auto prefers MPP when both are offered'),
        max_usd: z
          .string()
          .refine(
            (value) => parseUsd(value) !== null,
            'A USD amount such as "0.05"',
          )
          .describe(
            'The most you agree to pay for this call, in USD, e.g. "0.05"',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input) =>
      withGrant('payments:pay', async ({ grantId, userId, clientId }) => {
        const outcome = await env.API.payHttp(grantId, userId, clientId, {
          url: input.url,
          method: input.method,
          headers: input.headers,
          body: input.body,
          protocol: input.protocol,
          maxUsd: input.max_usd,
        })
        if (!outcome.ok) return toolError(outcome.error)
        return {
          content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        }
      }),
  )
  return server
}

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
        const auth = await env.OAUTH_PROVIDER.parseAuthRequest(request)
        if (
          auth.scope.length === 0 ||
          new Set(auth.scope).size !== auth.scope.length ||
          !auth.scope.every(isMcpScope)
        )
          return new Response('Unsupported access request', { status: 400 })
        const client = await env.OAUTH_PROVIDER.lookupClient(auth.clientId)
        if (!client) return new Response('Unknown MCP client', { status: 400 })
        const consent = await env.OAUTH_PROVIDER.beginConsent(auth)
        await env.API.recordConsent({
          handle: consent.handle,
          clientId: auth.clientId,
          clientName: client.clientName || 'Unnamed MCP client',
          redirectUri: auth.redirectUri,
          scopes: auth.scope,
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
            // Required by the API when the client asked for payments:pay.
            limitUsd: z.string().optional(),
          })
          .safeParse(await request.json().catch(() => null))
        if (!body.success) return json({ error: 'Invalid decision' }, 400)
        const limitMicroUsd =
          body.data.limitUsd === undefined ? null : parseUsd(body.data.limitUsd)
        if (body.data.limitUsd !== undefined && limitMicroUsd === null)
          return json({ error: 'Invalid spending limit' }, 400)
        try {
          if (body.data.decision === 'deny') {
            const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle)
            await env.API.discardConsent(handle)
            return json({ redirectTo: denied.redirectTo }, 200, denied.headers)
          }
          const pending = await env.API.pendingConsent(handle)
          if (
            pending?.scopes.includes('payments:pay') &&
            limitMicroUsd === null
          )
            return json({ error: 'Set a spending limit' }, 400)
          const token = /^Bearer (.+)$/.exec(
            request.headers.get('authorization') || '',
          )?.[1]
          if (!token) return json({ error: 'Sign in first' }, 401)
          const userId = await env.API.verifyPrivyToken(token)
          const approved = await env.OAUTH_PROVIDER.approveConsent(
            request,
            handle,
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
                approved.request.clientId,
                userId,
                grantId,
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
            env,
            ctx,
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
    const { grantId, userId, clientId } = identity.data
    let active: unknown
    try {
      active = await (bindings as McpEnv).API.whoami(grantId, userId, clientId)
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
