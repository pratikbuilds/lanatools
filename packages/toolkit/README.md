# Toolkit

`@lanatools/toolkit` is the contract every provider package (`helius`,
`jupiter`, `phoenix`) implements, plus an MCP adapter.

A provider has a `name`, a list of `tools` (name, title, description, zod
input) and one `run(name, input, options)` that never throws.

```ts
import { McpServer } from '@modelcontextprotocol/server'
import { registerTools } from '@lanatools/toolkit/mcp'
import { phoenix } from '@lanatools/phoenix'

const server = new McpServer({ name: 'my-agent-tools', version: '1.0.0' })
registerTools(server, phoenix.tools, (name, input) =>
  phoenix.run(name, input, {}),
)
```

Hosts own policy. The LanaTools API wraps `run` with grant checks and an
activity record; a script can call `run` directly.
