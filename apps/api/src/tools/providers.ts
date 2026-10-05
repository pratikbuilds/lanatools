import type { McpScope } from '@lanatools/contracts'
import { helius } from '@lanatools/helius'
import { jupiter } from '@lanatools/jupiter'
import { phoenix } from '@lanatools/phoenix'
import type { ToolInfo, ToolOutcome, ToolProvider } from '@lanatools/toolkit'
import { solanaConfig } from '../solana/network'
import type { SolanaEnv, SolanaNetwork } from '../solana/network'

export type ProviderEnv = SolanaEnv & {
  /** Server-managed Jupiter REST key; never exposed to MCP clients. */
  JUPITER_API_KEY?: string
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

/** A provider configured for one call, ready to run its tools. */
export type ConfiguredProvider = {
  network: SolanaNetwork['name']
  run: (name: string, input: unknown) => Promise<ToolOutcome>
}

/**
 * A provider package plus LanaTools policy: the grant scope its tools need
 * and the server configuration they run with.
 */
export type HostedProvider = {
  name: string
  tools: readonly ToolInfo[]
  /** The scope a grant needs; null lets any active grant use the tools. */
  scope: McpScope | null
  /** Reads server configuration, throwing when it is missing. */
  configure: (env: ProviderEnv, fetcher: Fetch) => Promise<ConfiguredProvider>
}

function host<TOptions>(
  provider: ToolProvider<TOptions>,
  scope: McpScope | null,
  options: (
    env: ProviderEnv,
    fetcher: Fetch,
  ) => Promise<{ network: SolanaNetwork['name']; options: TOptions }>,
): HostedProvider {
  return {
    name: provider.name,
    tools: provider.tools,
    scope,
    async configure(env, fetcher) {
      const configured = await options(env, fetcher)
      return {
        network: configured.network,
        run: (name, input) => provider.run(name, input, configured.options),
      }
    },
  }
}

/**
 * Every provider LanaTools serves. Adding one is one entry here: the MCP
 * server registers its tools and `callTool` authorizes, runs and records them.
 */
export const PROVIDERS: readonly HostedProvider[] = [
  host(helius, 'helius:read', async (env) => {
    const config = await solanaConfig(env)
    return { network: config.network.name, options: { rpcUrl: config.rpcUrl } }
  }),
  // Jupiter and Phoenix serve mainnet data whatever SOLANA_NETWORK says.
  host(jupiter, 'jupiter:read', async (env, fetcher) => ({
    network: 'mainnet',
    options: { apiKey: env.JUPITER_API_KEY ?? '', fetch: fetcher },
  })),
  host(phoenix, 'phoenix:read', async (_env, fetcher) => ({
    network: 'mainnet',
    options: { fetch: fetcher },
  })),
]
