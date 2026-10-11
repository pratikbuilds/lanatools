import type {
  AuthRequest,
  OAuthHelpers,
} from '@cloudflare/workers-oauth-provider'
import { z } from 'zod'
import {
  TOOL_SCOPES,
  grantScopes,
  parseClientLimit,
} from '@lanatools/contracts'
import type { McpScope, ToolScope } from '@lanatools/contracts'
import type { McpAccessService } from '../../api/src/mcp-service'
import { completeApproval } from './complete-approval'

export type GrantEnv = {
  OAUTH_PROVIDER: OAuthHelpers
  API: Service<typeof McpAccessService>
}

/** The tool families and spending limit a user chooses when connecting. */
export const ToolChoice = z.object({
  // Unscoped tools remain available when no families are selected.
  scopes: z.array(z.enum(TOOL_SCOPES)).default([]),
  // Required when the user allows payments.
  limitUsd: z.string().optional(),
})

export type ApprovedAccess = {
  toolScopes: ToolScope[]
  scopes: McpScope[]
  limitMicroUsd: number | null
}

/** Checks a user's choice, returning the access to grant or why it is refused. */
export function toolAccess(
  choice: z.infer<typeof ToolChoice>,
): ApprovedAccess | { error: string } {
  const scopes = grantScopes(choice.scopes)
  if (!scopes) return { error: 'Invalid tool access' }
  const limitMicroUsd =
    choice.limitUsd === undefined ? null : parseClientLimit(choice.limitUsd)
  if (choice.limitUsd !== undefined && limitMicroUsd === null)
    return { error: 'Invalid spending limit' }
  if (scopes.includes('payments:pay') && limitMicroUsd === null)
    return { error: 'Set a spending limit' }
  return { toolScopes: choice.scopes, scopes, limitMicroUsd }
}

/**
 * Issues the authorization code for a request the user approved, and
 * activates the matching LanaTools grant. The user's choice replaces the
 * scopes the client asked for. `handle` names the pending consent for it.
 */
export async function approveGrant(
  env: GrantEnv,
  request: AuthRequest,
  handle: string,
  userId: string,
  access: ApprovedAccess,
) {
  const { grantId } = await env.API.prepareGrant(
    handle,
    request.clientId,
    userId,
  )
  return completeApproval(
    () =>
      env.OAUTH_PROVIDER.completeAuthorization({
        request: { ...request, scope: access.scopes },
        // OAuthProvider separates the subject from its code with colons.
        userId: encodeURIComponent(userId),
        scope: access.scopes,
        props: { grantId, userId, clientId: request.clientId },
        // Lets a dashboard revocation find this OAuth grant in KV.
        metadata: { label: 'LanaTools connection', grantId },
      }),
    () =>
      env.API.activateGrant(
        handle,
        { grantId, userId, clientId: request.clientId },
        access.toolScopes,
        access.limitMicroUsd,
      ),
  )
}
