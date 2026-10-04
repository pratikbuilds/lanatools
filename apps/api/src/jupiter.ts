import { JupiterClient } from '@lanatools/jupiter'
import type {
  JupiterFetch,
  JupiterOutcome,
  JupiterRequest,
} from '@lanatools/jupiter'
import type { D1Database } from '@cloudflare/workers-types'
import { useActiveGrant } from './mcp-grants'
import type { GrantIdentity } from './mcp-grants'

/** Check the stored scope too: an OAuth token alone cannot authorize a read. */
export async function readJupiter(
  database: D1Database,
  identity: GrantIdentity,
  request: JupiterRequest,
  apiKey: string | undefined,
  fetcher: JupiterFetch = fetch,
): Promise<JupiterOutcome> {
  if (!(await useActiveGrant(database, identity, Date.now(), 'jupiter:read')))
    return {
      ok: false,
      error: {
        code: 'permission_denied',
        message: 'An active Jupiter access grant is required',
        retryable: false,
      },
    }
  return new JupiterClient({ apiKey: apiKey ?? '', fetch: fetcher }).read(
    request,
  )
}
