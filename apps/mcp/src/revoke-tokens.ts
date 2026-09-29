import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

/**
 * Deletes the OAuth grants, with their tokens, that a LanaTools grant issued.
 * Grants from before `metadata.grantId` existed are matched by client alone;
 * those always belonged to the user's single grant for that client.
 */
export async function revokeClientTokens(
  oauth: Pick<OAuthHelpers, 'listUserGrants' | 'revokeGrant'>,
  userId: string,
  clientId: string,
  grantId: string,
) {
  // OAuthProvider separates the subject from its code with colons.
  const subject = encodeURIComponent(userId)
  const matches: string[] = []
  let cursor: string | undefined
  do {
    const page = await oauth.listUserGrants(subject, cursor ? { cursor } : {})
    for (const grant of page.items) {
      const issuedFor: unknown = grant.metadata?.grantId
      if (
        grant.clientId === clientId &&
        (issuedFor === grantId || issuedFor === undefined)
      )
        matches.push(grant.id)
    }
    cursor = page.cursor
  } while (cursor)
  await Promise.all(matches.map((id) => oauth.revokeGrant(id, subject)))
}
