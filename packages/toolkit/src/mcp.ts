import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import type { ToolError, ToolInfo, ToolReply } from './index'

/** Every provider tool today reads data; none moves funds or writes state. */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

/** The one MCP shape for a failed call: `{ error: { code, message, ... } }`. */
export function toolError(error: ToolError): CallToolResult {
  const content = { error }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(content) }],
    structuredContent: content,
  }
}

/** Turns a provider outcome into an MCP tool result. */
export function toCallToolResult(outcome: ToolReply): CallToolResult {
  if (!outcome.ok) return toolError(outcome.error)
  const json = { type: 'text' as const, text: JSON.stringify(outcome.result) }
  const result = outcome.result
  return {
    content: outcome.summary
      ? [{ type: 'text', text: outcome.summary }, json]
      : [json],
    // MCP structured content must be an object, not an array or a value.
    ...(isPlainObject(result) ? { structuredContent: result } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Registers tools on an MCP server. `call` decides how each runs: in
 * process with `provider.run`, or through a host that authorizes and records
 * it. The MCP SDK validates input against the schema before `call` runs.
 */
export function registerTools(
  server: McpServer,
  tools: readonly ToolInfo[],
  call: (name: string, input: unknown) => Promise<ToolReply>,
) {
  for (const tool of tools)
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: READ_ONLY,
      },
      async (input: unknown) => toCallToolResult(await call(tool.name, input)),
    )
}
