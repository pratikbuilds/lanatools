import { drizzle } from 'drizzle-orm/d1'
import type { D1Database } from '@cloudflare/workers-types'
import { agentFeedback } from './db/schema'
import { authorizeGrant } from './mcp-grants'
import type { GrantIdentity } from './mcp-grants'

/**
 * Saves feedback an agent sent for an active grant. Returns false once the
 * grant is revoked.
 */
export async function saveFeedback(
  database: D1Database,
  identity: GrantIdentity,
  feedback: string,
  now = Date.now(),
) {
  if ((await authorizeGrant(database, identity, null, now)) !== 'active')
    return false
  try {
    await drizzle(database).insert(agentFeedback).values({
      id: crypto.randomUUID(),
      privyUserId: identity.userId,
      clientId: identity.clientId,
      grantId: identity.grantId,
      feedback,
      createdAt: now,
    })
  } catch {
    // D1 errors can include bound values. Keep the feedback text out of them.
    throw new Error('Could not save feedback')
  }
  return true
}
