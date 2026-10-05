import type { z } from 'zod'

/**
 * The contract every LanaTools provider package implements. A provider is a
 * family of tools (Helius, Jupiter, Phoenix) that runs anywhere: in an MCP
 * server, an HTTP API or a script. Hosts decide who may call it and where its
 * results go; providers only describe and run their tools.
 */

/** What an agent sees for one tool. */
export type ToolInfo = {
  /** Unique across providers, e.g. `jupiter_get_prices`. */
  name: string
  title: string
  description: string
  input: z.ZodType
}

/** A failure that is safe to show an agent: no URLs, keys or raw bodies. */
export type ToolError = { code: string; message: string; retryable: boolean }

export type ToolOutcome =
  | {
      ok: true
      result: unknown
      /** Optional one-line reading of the result for an agent. */
      summary?: string
      /** Estimated provider credits the call used. */
      credits: number
    }
  | { ok: false; error: ToolError; credits: number }

/** An outcome as a host returns it to an agent, without provider credits. */
export type ToolReply =
  | { ok: true; result: unknown; summary?: string }
  | { ok: false; error: ToolError }

export interface ToolProvider<TOptions> {
  /** Stable lowercase name, recorded with each call, e.g. `helius`. */
  name: string
  tools: readonly ToolInfo[]
  /**
   * Validates `input` against the named tool and runs it. Never throws:
   * every failure comes back as a safe `ToolError`.
   */
  run: (name: string, input: unknown, options: TOptions) => Promise<ToolOutcome>
}

/** Declares a provider, keeping its options type for callers. */
export function defineProvider<TOptions>(provider: ToolProvider<TOptions>) {
  return provider
}

/** Finds the provider that owns a tool name. */
export function lookupTool<TProvider extends { tools: readonly ToolInfo[] }>(
  providers: readonly TProvider[],
  name: string,
) {
  for (const provider of providers) {
    const tool = provider.tools.find((item) => item.name === name)
    if (tool) return { provider, tool }
  }
  return null
}
