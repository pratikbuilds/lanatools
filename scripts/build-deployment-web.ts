import { readSolanaNetwork } from '../packages/contracts/src/networks'
import type { NetworkId } from '../packages/contracts/src/networks'

/** The API deployment defines the network its paired web build must display. */
export function webDeploymentEnv(
  apiConfigText: string,
  ambient: Record<string, string | undefined>,
): Record<string, string | undefined> & { SOLANA_NETWORK: NetworkId } {
  const config: unknown = Bun.JSONC.parse(apiConfigText)
  if (
    !config ||
    typeof config !== 'object' ||
    !('vars' in config) ||
    !config.vars ||
    typeof config.vars !== 'object' ||
    !('SOLANA_NETWORK' in config.vars) ||
    typeof config.vars.SOLANA_NETWORK !== 'string'
  )
    throw new Error('API deployment must configure SOLANA_NETWORK')
  return {
    ...ambient,
    SOLANA_NETWORK: readSolanaNetwork({
      SOLANA_NETWORK: config.vars.SOLANA_NETWORK,
    }),
  }
}

if (import.meta.main) {
  const root = new URL('../', import.meta.url).pathname
  const env = webDeploymentEnv(
    await Bun.file(
      new URL('../apps/api/wrangler.jsonc', import.meta.url),
    ).text(),
    process.env,
  )
  const result = Bun.spawnSync(['bun', 'run', '--cwd', 'apps/web', 'build'], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(result.exitCode)
}
